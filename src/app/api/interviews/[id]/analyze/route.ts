// /api/interviews/[id]/analyze?studyId=... - Researcher-triggered interview
// analysis. Two backends share the URL:
//
// Node target (POST only): the synchronous recovery path (slice P) for
// everything the deferred after() run in save/route.ts could not finish, and
// the only way to analyze an interview that was never deferred (e.g. legacy
// pending records). One interview per press; StudyDetail's batch action calls
// this route sequentially, never a server-side batch (P8.2). It ignores the
// additive v2 headers and body.
//
// Cloudflare target: durable analysis API v2 (03-analysis-jobs.md API-01/02,
// JOB-02/04). POST accepts an explicit retry as a durable generation and
// returns 202 without waiting for the provider; GET reads the closed status
// projection and never allocates, dispatches or retries. The Queue consumer,
// never this route, calls the provider.

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

import { NextResponse } from 'next/server';
import { getInterviewChecked } from '@/lib/kv';
import {
  getAuthorizedResearcherStudyContext,
  providerKeysFromContext,
} from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  frozenAnalysisInput,
  loadCanonicalStudy,
  workspaceHeldResponse,
} from '@/lib/canonicalStudy';
import { mapInterviewLoad } from '@/lib/ownedStudies';
import { hostedAiRateLimitResponse } from '@/lib/platformAiRateLimit';
import { runInterviewAnalysis } from '@/lib/interviewAnalysis';
import { createRequestId, logRequestEvent, logRequestFailure } from '@/lib/requestLog';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { UUID_V4 } from '@/lib/uuid';
import { isCloudflareTarget } from '@/lib/runtime/capabilities';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import type { ProviderRoute } from '@/lib/providers/endpoint';
import {
  currentProviderTransport,
  researcherTransportNotDisclosedResponse,
} from '@/lib/transportDisclosure';
import {
  ANALYSIS_POLL_AFTER_MS,
  type AcceptAnalysisRetryOutcome,
  type AnalysisStatusBody,
} from '@/lib/storage/analysisProtocol';
import {
  isDurableWorkspaceStore,
  type DurableWorkspaceStorePort,
  type WorkspaceHoldReason,
} from '@/lib/storage/types';
import type { InterviewAnalysisFailureKind } from '@/types';
import { commitmentCovers } from '@/lib/providerCommitment';
import { researcherProviderNotDisclosedResponse } from '@/lib/providerCommitmentResponse';

const ROUTE = '/api/interviews/[id]/analyze';
const STUDY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  // F10: a not-ready Cloudflare installation refuses before authentication,
  // storage or allocation. Always null on the Node target.
  const notReady = deploymentNotReadyResponse(ROUTE);
  if (notReady) return notReady;
  if (isCloudflareTarget()) return durableAnalysisPost(request, params);
  return synchronousAnalysisPost(request, params);
}

export async function GET(request: Request, { params }: RouteParams) {
  // The status endpoint exists only on the durable backend. Clients call it
  // only when readiness advertises analysisExecution 'queued-v2' (RT-08); the
  // Node target keeps answering this method (and HEAD, which Next maps to
  // GET) exactly as Next did before the endpoint existed: a bare 405.
  if (!isCloudflareTarget()) return new Response(null, { status: 405 });
  return durableAnalysisGet(request, params);
}

// Next derives OPTIONS from the exported handlers, which would advertise
// GET and HEAD on the Node target where they are not served. This keeps the
// Node answer Next gave before GET was exported.
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: isCloudflareTarget() ? 'GET, HEAD, OPTIONS, POST' : 'OPTIONS, POST' },
  });
}

// ---------- Node target: synchronous analysis (unchanged) ----------

async function synchronousAnalysisPost(request: Request, params: RouteParams['params']) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing interview ID' }, { status: 400 });
    }

    // Required in both modes, unlike the plain GET: authority is per-study,
    // and an analyze request with no study to gate on has nothing to check.
    const studyId = new URL(request.url).searchParams.get('studyId');
    if (!studyId || !STUDY_ID_PATTERN.test(studyId)) {
      return NextResponse.json({ error: 'Missing or invalid study ID' }, { status: 400 });
    }

    const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
    const denied = configurationRequiredResponse(gated);
    if (denied) return denied;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
          ...(gated.reason ? { reason: gated.reason } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }

    const loaded = await getInterviewChecked(id, gated.context.kvClient);
    const mapped = mapInterviewLoad(loaded);
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    // Cross-tenant refusal, same as the plain GET (interviews/[id]/route.ts).
    if (mapped.interview.studyId !== studyId) {
      return NextResponse.json({ error: 'Interview not found' }, { status: 404 });
    }

    const canonical = await loadCanonicalStudy({
      store: gated.context.store,
      tokenStudyId: studyId,
      isAdmin: true,
    });
    if (!canonical.ok) return canonical.response;

    // A fixed provider commitment: the transcript goes only to the provider
    // and model its participant's consent named, whatever the study uses now.
    if (!commitmentCovers(mapped.interview, canonical.study.config.aiProvider, canonical.study.config.aiModel)) {
      return researcherProviderNotDisclosedResponse();
    }

    const platformLimited = await hostedAiRateLimitResponse(
      request,
      'analysis',
      { researcherId: gated.researcherId },
    );
    if (platformLimited) return platformLimited;

    const outcome = await runInterviewAnalysis({
      interviewId: id,
      study: canonical.study,
      kvClient: gated.context.kvClient,
      providerKeys: providerKeysFromContext(gated.context),
      platformAuthority: { researcherId: gated.researcherId },
    });

    if (outcome.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Interview storage is temporarily unavailable. Please try again.', retryable: true },
        { status: 503 },
      );
    }

    // A recorded failed analysis is a successful report of a failure: the researcher
    // is being told a record fact, not a provider fact. 200 for all four.
    // `not-found` only arises from a race between the tenancy check above
    // and the claim itself (the interview vanished mid-request); it is
    // reported as `busy` rather than growing the response's status enum.
    if (outcome.status === 'failed') {
      return NextResponse.json({ status: 'failed', failureKind: outcome.failureKind });
    }
    return NextResponse.json({ status: outcome.status === 'not-found' ? 'busy' : outcome.status });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to analyze interview' },
      { status: 500 }
    );
  }
}

// ---------- Cloudflare target: durable analysis API v2 ----------

const INTERVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ANALYSIS_VERSION_HEADER = 'X-OpenInterviewer-Analysis-Version';
const ANALYSIS_API_VERSION = '2';
/** `{"expectedGeneration":9007199254740991}` is 38 bytes; nothing larger is a valid body. */
const MAX_ANALYSIS_BODY_BYTES = 256;

const START_UNAVAILABLE = 'Analysis is temporarily unavailable. Please try again.';
const STATUS_UNAVAILABLE = 'The analysis status is temporarily unavailable. Please try again.';
const FAILURE_KINDS: ReadonlySet<InterviewAnalysisFailureKind> = new Set([
  'provider',
  'invalid-output',
  'too-large',
  'timeout',
  'storage',
]);

type Method = 'POST' | 'GET';

/** Every durable response is private and uncacheable (API-02). */
function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function withNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function unavailable(method: Method): NextResponse {
  return noStoreJson({ error: method === 'POST' ? START_UNAVAILABLE : STATUS_UNAVAILABLE, retryable: true }, 503);
}

type DurableTarget = {
  interviewId: string;
  studyId: string;
  store: DurableWorkspaceStorePort;
  providerRoute: ProviderRoute | null | undefined;
};

/**
 * Path/query shape, then the researcher session (a participant cookie or
 * link never authorizes this route), then the durable store. The matching
 * study/interview check happens inside the store's own read or transaction.
 */
async function resolveDurableTarget(
  request: Request,
  params: RouteParams['params'],
  method: Method,
): Promise<{ ok: true; target: DurableTarget } | { ok: false; response: NextResponse }> {
  const { id } = await params;
  if (!id || !INTERVIEW_ID_PATTERN.test(id)) {
    return { ok: false, response: noStoreJson({ error: 'Missing or invalid interview ID' }, 400) };
  }
  const studyId = new URL(request.url).searchParams.get('studyId');
  if (!studyId || !STUDY_ID_PATTERN.test(studyId)) {
    return { ok: false, response: noStoreJson({ error: 'Missing or invalid study ID' }, 400) };
  }

  const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
  const denied = configurationRequiredResponse(gated);
  if (denied) return { ok: false, response: withNoStore(denied) };
  if (!gated.authorized || !gated.context) {
    return {
      ok: false,
      response: noStoreJson(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
          ...(gated.reason ? { reason: gated.reason } : {}),
        },
        gated.statusCode ?? 401,
      ),
    };
  }

  const store = gated.context.store;
  if (!isDurableWorkspaceStore(store)) {
    // The Cloudflare target always resolves the Durable Object store; any
    // other backend here is misconfiguration, never a synchronous fallback.
    logRequestEvent({ event: 'workspace.store', route: ROUTE, method, status: 503, reason: 'not-configured' });
    return {
      ok: false,
      response: noStoreJson(
        { error: 'Workspace storage is not configured for this deployment.', retryable: false, reason: 'not-configured' },
        503,
      ),
    };
  }
  return { ok: true, target: { interviewId: id, studyId, store, providerRoute: gated.context.providerRoute } };
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(';')[0].trim().toLowerCase() === 'application/json';
}

/** The whole body is `{ expectedGeneration: <nonnegative safe integer> }`. */
function parseExpectedGeneration(body: Record<string, unknown>): number | null {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'expectedGeneration') return null;
  return isGeneration(body.expectedGeneration) ? body.expectedGeneration : null;
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Rebuild the closed projection field by field (API-02): nothing the store
 * returns beyond these fields can reach the response. Null when the body is
 * outside the contract for this method.
 */
function closedStatusBody(body: AnalysisStatusBody | undefined, method: Method): AnalysisStatusBody | null {
  if (!body || typeof body !== 'object' || !isGeneration(body.generation)) return null;
  const generation = body.generation;
  switch (body.status) {
    case 'pending':
      if (body.phase === 'not-scheduled') {
        // Unscheduled legacy work exists only at generation 0 and only a read reports it.
        return method === 'GET' && generation === 0 ? { status: 'pending', generation, phase: 'not-scheduled' } : null;
      }
      if ((body.phase === 'queued' || body.phase === 'running') && generation >= 1) {
        return { status: 'pending', generation, phase: body.phase, pollAfterMs: ANALYSIS_POLL_AFTER_MS };
      }
      return null;
    case 'complete':
      return { status: 'complete', generation };
    case 'already-complete':
      return method === 'POST' ? { status: 'already-complete', generation } : null;
    case 'failed':
      if (!FAILURE_KINDS.has(body.failureKind) || typeof body.recoveryRequired !== 'boolean') return null;
      return { status: 'failed', generation, failureKind: body.failureKind, recoveryRequired: body.recoveryRequired };
    default:
      return null;
  }
}

/**
 * A held workspace (maintenance, recovery-epoch or identity mismatch,
 * uninitialized, unsupported schema) refused the retry without allocating.
 * Public reason `maintenance` or `workspace-unavailable`; the internal hold
 * reason goes to the allowlisted log only. Retryable in every case, as every
 * API-01 503 is: the client repeats the same key and body.
 */
function heldResponse(reason: string): NextResponse {
  return workspaceHeldResponse({
    route: ROUTE,
    reason: reason as WorkspaceHoldReason,
    error: 'Analysis is paused while this workspace is under maintenance. Try again later.',
    unavailableError: START_UNAVAILABLE,
    retryable: true,
  });
}

function acceptOutcomeResponse(outcome: AcceptAnalysisRetryOutcome): NextResponse {
  switch (outcome.status) {
    case 'accepted':
    case 'existing':
    case 'already-complete': {
      // A receipt replay reports the referenced generation's current outcome,
      // which may already be terminal: 202 only while work is pending.
      const body = closedStatusBody(outcome.body, 'POST');
      if (body) return noStoreJson(body, body.status === 'pending' ? 202 : 200);
      logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'POST', status: 503, reason: 'invalid' });
      return unavailable('POST');
    }
    case 'state-changed':
      return noStoreJson(
        {
          code: 'ANALYSIS_STATE_CHANGED',
          error: 'This interview’s analysis changed since the page loaded. Check its latest status before running it again.',
        },
        409,
      );
    case 'key-conflict':
      return noStoreJson(
        {
          code: 'ANALYSIS_REQUEST_KEY_CONFLICT',
          error: 'This analysis request key was already used for a different request.',
        },
        409,
      );
    case 'not-found':
      return noStoreJson({ error: 'Interview not found' }, 404);
    case 'transport-not-disclosed':
      return researcherTransportNotDisclosedResponse(1, { 'Cache-Control': 'no-store' });
    case 'provider-not-disclosed':
      return researcherProviderNotDisclosedResponse({ 'Cache-Control': 'no-store' });
    case 'held':
      return heldResponse(outcome.reason);
    default:
      // corrupt (already logged by the store as corrupt-record) or
      // unavailable, including an allocation whose commit is unknown: the
      // client retries the same key and body.
      logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'POST', status: 503, reason: 'unavailable' });
      return unavailable('POST');
  }
}

async function durableAnalysisPost(request: Request, params: RouteParams['params']): Promise<NextResponse> {
  try {
    const resolved = await resolveDurableTarget(request, params, 'POST');
    if (!resolved.ok) return resolved.response;
    const { interviewId, studyId, store, providerRoute } = resolved.target;

    // API-01: an older cached client must not start work it cannot follow.
    // Checked after authentication (F18) and before any parsing or mutation.
    if (request.headers.get(ANALYSIS_VERSION_HEADER)?.trim() !== ANALYSIS_API_VERSION) {
      return noStoreJson(
        { code: 'ANALYSIS_CLIENT_UPDATE_REQUIRED', error: 'Reload this page to analyze interviews.' },
        409,
      );
    }
    const idempotencyKey = request.headers.get('Idempotency-Key')?.trim() ?? '';
    if (!UUID_V4.test(idempotencyKey)) {
      return noStoreJson({ error: 'Idempotency-Key header must be a UUID.' }, 400);
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return noStoreJson({ error: 'Content-Type must be application/json.' }, 400);
    }
    const parsed = await readBoundedJsonObject(request, MAX_ANALYSIS_BODY_BYTES);
    if (!parsed.ok && parsed.status === 413) {
      return noStoreJson({ error: 'Analysis request body is too large.' }, 413);
    }
    const expectedGeneration = parsed.ok ? parseExpectedGeneration(parsed.value) : null;
    if (expectedGeneration === null) {
      return noStoreJson({ error: 'Analysis request body must be {"expectedGeneration": <generation>}.' }, 400);
    }

    // JOB-02: acceptance-time inputs from the canonical study, with its own
    // explicit provider and model resolved before persistence.
    const canonical = await loadCanonicalStudy({ store, tokenStudyId: studyId, isAdmin: true });
    if (!canonical.ok) return withNoStore(canonical.response);

    const frozen = frozenAnalysisInput(canonical.study);
    if (!frozen.ok) return withNoStore(frozen.response);

    // D9: the store allocates the paid generation only when the interview's
    // recorded disclosure covers the transport this request would use now,
    // and freezes that disclosure with it. An invalid route accepts nothing.
    const current = currentProviderTransport({ providerRoute }, canonical.study.config.aiProvider);
    if (!current.applies || !current.ok) {
      logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'POST', status: 503, reason: 'provider-route-invalid' });
      return noStoreJson({ error: 'AI provider is not configured on the server.', retryable: false }, 503);
    }

    const outcome = await store.acceptAnalysisRetry({
      studyId,
      interviewId,
      rawIdempotencyKey: idempotencyKey,
      apiVersion: 2,
      expectedGeneration,
      input: frozen.input,
      ...(current.transport === 'cloudflare-gateway' ? { transport: current.transport } : {}),
      now: Date.now(),
    });
    return acceptOutcomeResponse(outcome);
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'POST',
      status: 503,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    // The allocation may have committed: 503 retryable, same key and body.
    return unavailable('POST');
  }
}

async function durableAnalysisGet(request: Request, params: RouteParams['params']): Promise<NextResponse> {
  try {
    const resolved = await resolveDurableTarget(request, params, 'GET');
    if (!resolved.ok) return resolved.response;
    const { interviewId, studyId, store } = resolved.target;

    const outcome = await store.readAnalysisStatus({ studyId, interviewId });
    if (outcome.status === 'ok') {
      const body = closedStatusBody(outcome.body, 'GET');
      if (body) return noStoreJson(body, 200);
      logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'GET', status: 503, reason: 'invalid' });
      return unavailable('GET');
    }
    if (outcome.status === 'not-found') return noStoreJson({ error: 'Interview not found' }, 404);
    logRequestEvent({ event: 'route.failure', route: ROUTE, method: 'GET', status: 503, reason: 'unavailable' });
    return unavailable('GET');
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'GET',
      status: 503,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return unavailable('GET');
  }
}
