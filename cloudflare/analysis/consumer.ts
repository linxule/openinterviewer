// Queue consumer for durable analysis (JOB-06/07/08/09). Provider execution
// happens here, outside the Durable Object and outside any transaction. The
// provider is called only after the object durably confirms this invocation's
// start marker; every handled message is explicitly acknowledged, and a
// caught provider failure never retries the batch.

import {
  ANALYSIS_ATTACH_MARGIN_MS,
  QUEUED_SYNTHESIS_DEADLINE_MS,
  validateAnalysisMessage,
  type AnalysisMessageV1,
  type ClaimAnalysisJobInput,
  type ClaimAnalysisJobOutcome,
  type FinishAnalysisJobInput,
  type FinishAnalysisJobOutcome,
  type JobFence,
  type MarkStartedInput,
  type MarkStartedOutcome,
} from '../../src/lib/storage/analysisProtocol';
import type { AIProvider } from '../../src/lib/ai';
import type { WorkspaceStore } from '../workspace/WorkspaceStore';
import { executeQueuedSynthesis, loadQueuedSynthesisProvider, providerKeyFromEnv } from './execute';
import { covers, effectiveTransport, providerEndpoint, resolveProviderRoute } from '../../src/lib/providers/endpoint';
import { resolveCapabilities } from '../../src/lib/runtime/capabilities';
import { logJobEvent } from './telemetry';

export type ConsumerEnv = {
  WORKSPACE_STORE: DurableObjectNamespace<WorkspaceStore>;
  WORKSPACE_ID?: string;
  WORKSPACE_JURISDICTION?: string;
  ANALYSIS_RECOVERY_EPOCH?: string;
  [key: string]: unknown;
};

export type ConsumerOptions = {
  /** Synthesis deadline; production always uses QUEUED_SYNTHESIS_DEADLINE_MS. */
  synthesisDeadlineMs?: number;
};

/** Transport retry after an unconfirmed RPC; no provider request was made. */
export const TRANSPORT_RETRY_DELAY_SECONDS = 30;

type Disposition = 'ack' | 'retry';

/** The consumer-only RPCs; results are plain structured-clone data. */
type JobRpc = {
  claimAnalysisJob(input: ClaimAnalysisJobInput): Promise<ClaimAnalysisJobOutcome>;
  markAnalysisStarted(input: MarkStartedInput): Promise<MarkStartedOutcome>;
  finishAnalysisJob(input: FinishAnalysisJobInput): Promise<FinishAnalysisJobOutcome>;
};

export async function handleAnalysisBatch(
  batch: MessageBatch<unknown>,
  env: ConsumerEnv,
  ctx: ExecutionContext,
  options: ConsumerOptions = {},
): Promise<void> {
  void ctx;
  for (const message of batch.messages) {
    await handleMessage(message, env, options);
  }
}

async function handleMessage(message: Message<unknown>, env: ConsumerEnv, options: ConsumerOptions): Promise<void> {
  const validation = validateAnalysisMessage(message.body);
  if (validation.status === 'unknown-version') {
    // Retried to the dead-letter queue for operator diagnosis; never executed.
    logJobEvent({ operation: 'consume', reason: 'dead-letter' });
    message.retry();
    return;
  }
  if (validation.status === 'invalid') {
    logJobEvent({ operation: 'consume', reason: 'message-invalid' });
    message.ack();
    return;
  }
  const job = validation.message;
  if (job.workspaceId !== env.WORKSPACE_ID) {
    logJobEvent({ operation: 'consume', reason: 'workspace-identity-mismatch' });
    message.ack();
    return;
  }
  if (job.recoveryEpoch !== env.ANALYSIS_RECOVERY_EPOCH) {
    logJobEvent({ operation: 'consume', reason: 'epoch-mismatch' });
    message.ack();
    return;
  }
  const progress = { providerStarted: false };
  let disposition: Disposition;
  try {
    disposition = await processJob(job, env, options, progress);
  } catch (error) {
    // Unexpected fault. Before the start marker nothing was paid for: retry
    // the transport. After it, the started job's lease watchdog covers it.
    logJobEvent({ operation: 'consume', reason: 'unknown-outcome', error });
    disposition = progress.providerStarted ? 'ack' : 'retry';
  }
  if (disposition === 'ack') message.ack();
  else message.retry({ delaySeconds: TRANSPORT_RETRY_DELAY_SECONDS });
}

function workspaceStub(env: ConsumerEnv): JobRpc {
  const jurisdiction = env.WORKSPACE_JURISDICTION;
  const namespace = typeof jurisdiction === 'string' && jurisdiction !== ''
    ? env.WORKSPACE_STORE.jurisdiction(jurisdiction as DurableObjectJurisdiction)
    : env.WORKSPACE_STORE;
  return namespace.getByName(env.WORKSPACE_ID as string) as unknown as JobRpc;
}

/**
 * One RPC plus at most one replay with the same identity. A fresh stub is used
 * for the replay because a stub can be left broken by the failure.
 */
async function withOneReplay<T>(call: (stub: JobRpc) => Promise<T>, env: ConsumerEnv): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, value: await call(workspaceStub(env)) };
    } catch {
      // Unknown outcome: replay once with the same nonce and inputs.
    }
  }
  return { ok: false };
}

async function processJob(
  job: AnalysisMessageV1,
  env: ConsumerEnv,
  options: ConsumerOptions,
  progress: { providerStarted: boolean },
): Promise<Disposition> {
  const fence: JobFence = {
    workspaceId: job.workspaceId,
    interviewId: job.interviewId,
    jobId: job.jobId,
    generation: job.generation,
    recoveryEpoch: job.recoveryEpoch,
  };
  // Fresh per invocation: another invocation can never assume this claim.
  const claimNonce = crypto.randomUUID();
  const deadlineMs = options.synthesisDeadlineMs ?? QUEUED_SYNTHESIS_DEADLINE_MS;

  const claim = await withOneReplay(
    (stub) => stub.claimAnalysisJob({ ...fence, claimNonce, now: Date.now() }),
    env,
  );
  if (!claim.ok) {
    logJobEvent({ operation: 'claim', reason: 'unknown-outcome' });
    return 'retry';
  }
  const claimed = claim.value;
  switch (claimed.status) {
    case 'claimed':
      break;
    case 'unavailable':
      logJobEvent({ operation: 'claim', reason: 'unavailable' });
      return 'retry';
    case 'corrupt':
      logJobEvent({ operation: 'claim', reason: 'corrupt-record' });
      return 'ack';
    case 'held':
      logJobEvent({ operation: 'claim', reason: 'maintenance-hold' });
      return 'ack';
    case 'not-found':
    case 'cancelled':
      logJobEvent({ operation: 'claim', reason: 'not-found' });
      return 'ack';
    case 'busy':
      logJobEvent({ operation: 'claim', reason: 'claim-lost' });
      return 'ack';
    case 'stale':
    case 'terminal':
      logJobEvent({ operation: 'claim', reason: 'generation-stale' });
      return 'ack';
  }

  const { frozen } = claimed.inputs;
  const finish = (outcome: FinishAnalysisJobInput['outcome']) => withOneReplay(
    (stub) => stub.finishAnalysisJob({ ...fence, claimNonce, now: Date.now(), outcome }),
    env,
  );

  // The route comes from this invocation's env: the Queue path has no
  // readiness gate, so the deployment capability and the route (transport,
  // gateway identifiers and token, SDK override variables) are checked here,
  // before any key or adapter. Then the transport this provider would use
  // must be covered by the one disclosed at consent (D9). Every refusal
  // below is a known failure recorded without any provider request.
  const capable = resolveCapabilities(env as Record<string, string | undefined>);
  const route = capable.ok && capable.capabilities.target === 'cloudflare'
    ? resolveProviderRoute(env)
    : { ok: false as const, error: 'invalid_ai_transport' as const };
  const transport = route.ok ? effectiveTransport(route.route, frozen.requestedProvider) : null;
  const disclosed = frozen.disclosedTransport ?? 'direct';
  const covered = transport !== null && covers(disclosed, transport);
  const key = covered ? providerKeyFromEnv(env, frozen.requestedProvider) : null;
  let provider: AIProvider | null = null;
  if (route.ok && covered && key) {
    try {
      // Validated, loaded and constructed before the start marker.
      provider = await loadQueuedSynthesisProvider(
        frozen.requestedProvider,
        frozen.requestedModel,
        key,
        providerEndpoint(frozen.requestedProvider, route.route),
      );
    } catch {
      provider = null;
    }
  }
  if (!provider || !route.ok || transport === null) {
    logJobEvent({
      operation: 'execute',
      reason: !route.ok
        ? 'provider-route-invalid'
        : !covered
          ? 'transport-not-disclosed'
          : key ? 'provider-failure' : 'provider-key-missing',
      provider: frozen.requestedProvider,
      ...(transport ? { transport } : {}),
    });
    const recorded = await finish({ kind: 'failed', failureKind: 'provider' });
    if (!recorded.ok) logJobEvent({ operation: 'finish', reason: 'unknown-outcome' });
    // An unrecorded failure leaves a claimed lease that the watchdog returns to pending.
    return 'ack';
  }

  const start = await withOneReplay(
    (stub) => stub.markAnalysisStarted({
      ...fence,
      claimNonce,
      requiredRemainingMs: deadlineMs + ANALYSIS_ATTACH_MARGIN_MS,
      now: Date.now(),
    }),
    env,
  );
  if (!start.ok) {
    logJobEvent({ operation: 'start', reason: 'unknown-outcome' });
    return 'retry';
  }
  switch (start.value.status) {
    case 'started':
      break;
    case 'unavailable':
      logJobEvent({ operation: 'start', reason: 'unavailable' });
      return 'retry';
    case 'lease-insufficient':
      logJobEvent({ operation: 'start', reason: 'lease-expired' });
      return 'ack';
    case 'held':
      logJobEvent({ operation: 'start', reason: 'maintenance-hold' });
      return 'ack';
    case 'stale':
      logJobEvent({ operation: 'start', reason: 'generation-stale' });
      return 'ack';
  }

  progress.providerStarted = true;
  const startedAt = Date.now();
  const classified = await executeQueuedSynthesis(provider, claimed.inputs, deadlineMs, transport);
  logJobEvent({
    operation: 'execute',
    ...(classified.reason ? { reason: classified.reason } : {}),
    provider: frozen.requestedProvider,
    transport,
    durationMs: Date.now() - startedAt,
  });

  const settled = await finish(classified.outcome);
  if (!settled.ok) {
    // Never convert an unconfirmed attach into a failure: the started job's
    // lease watchdog records recovery-required if nothing was written.
    logJobEvent({ operation: 'finish', reason: 'unknown-outcome' });
    return 'ack';
  }
  if (settled.value.status !== 'written') {
    logJobEvent({ operation: 'finish', reason: finishReason(settled.value.status) });
  }
  return 'ack';
}

function finishReason(status: 'too-large' | 'lease-expired' | 'stale' | 'held' | 'corrupt' | 'unavailable') {
  switch (status) {
    case 'too-large':
      return 'too-large' as const;
    case 'lease-expired':
      return 'lease-expired' as const;
    case 'stale':
      return 'generation-stale' as const;
    case 'held':
      return 'maintenance-hold' as const;
    case 'corrupt':
      return 'corrupt-record' as const;
    case 'unavailable':
      return 'unavailable' as const;
  }
}
