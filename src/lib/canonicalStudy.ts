// Canonical study resolution for participant-facing routes
// Authority (provider/model/prompts/study identity) always comes from the saved
// study record loaded server-side through the request's workspace store,
// never from request bodies. The participant token's studyId is authoritative;
// a legacy body studyConfig may carry only the study id, and solely for
// authenticated admin previews.
//
// Also the shared HTTP translation for a held durable workspace (Cloudflare
// target) used by the participant and preview routes.

import { NextResponse } from 'next/server';
import type { StoredStudy } from '@/types';
import { validateStudyConfig } from './studyConfigValidation';
import { logRequestEvent, type RequestLogReason } from './requestLog';
import { participantStoreAdmissionResponse } from './rateLimit';
import { isProviderType, resolveSynthesisModel } from './providers/synthesisModel';
import { ANALYSIS_INPUT_SCHEMA_VERSION, type FrozenAnalysisInput } from './storage/analysisProtocol';
import {
  isDurableWorkspaceStore,
  type WorkspaceHoldReason,
  type WorkspaceStorePort,
} from './storage/types';

const STUDY_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export type CanonicalStudyResult =
  | { ok: true; study: StoredStudy }
  | { ok: false; response: NextResponse };

function malformedStudyResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Study configuration is unavailable. Ask the researcher to review and save the study.' },
    { status: 503 }
  );
}

export async function loadCanonicalStudy(opts: {
  store: Pick<WorkspaceStorePort, 'getStudy'>;
  tokenStudyId?: string;
  legacyBodyStudyId?: string;
  isAdmin?: boolean;
}): Promise<CanonicalStudyResult> {
  // Token wins. The body id is accepted only for admin previews.
  const studyId = opts.tokenStudyId || (opts.isAdmin ? opts.legacyBodyStudyId : undefined);

  if (!studyId) {
    return { ok: false, response: NextResponse.json({ error: 'Missing study context' }, { status: 400 }) };
  }
  if (!STUDY_ID_PATTERN.test(studyId)) {
    return { ok: false, response: NextResponse.json({ error: 'Invalid study ID' }, { status: 400 }) };
  }

  let loaded: Awaited<ReturnType<WorkspaceStorePort['getStudy']>>;
  try {
    loaded = await opts.store.getStudy(studyId);
  } catch {
    loaded = { status: 'unavailable' };
  }
  if (loaded.status === 'unavailable') {
    logRequestEvent({ event: 'workspace.store', route: 'canonical-study', status: 503, reason: 'unavailable' });
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Study storage is temporarily unavailable. Please try again.', retryable: true },
        { status: 503 }
      ),
    };
  }
  if (loaded.status !== 'found') {
    return { ok: false, response: NextResponse.json({ error: 'Study not found or no longer active' }, { status: 404 }) };
  }

  const study = loaded.study;
  const validated = validateStudyConfig(study.config);
  if (
    !validated.ok
    || study.id !== studyId
    || study.config.id !== studyId
    || !Number.isSafeInteger(study.revision)
    || study.revision < 1
  ) {
    logRequestEvent({ event: 'route.failure', route: 'canonical-study', errorType: 'MalformedStudy' });
    return { ok: false, response: malformedStudyResponse() };
  }
  return { ok: true, study: { ...study, config: validated.config } };
}

/**
 * Initial-generation analysis inputs frozen at save time (JOB-02). The model
 * is resolved here, before persistence, and is always the study's explicit
 * choice: an implicit environment or provider default is never persisted.
 */
export function frozenAnalysisInput(
  study: StoredStudy,
): { ok: true; input: FrozenAnalysisInput } | { ok: false; response: NextResponse } {
  const provider = study.config.aiProvider;
  let model: string;
  try {
    model = resolveSynthesisModel(study.config);
  } catch {
    model = '';
  }
  if (!isProviderType(provider) || !model || !Number.isSafeInteger(study.revision) || study.revision < 1) {
    logRequestEvent({ event: 'route.failure', route: 'canonical-study', errorType: 'MalformedStudy' });
    return { ok: false, response: malformedStudyResponse() };
  }
  return {
    ok: true,
    input: {
      inputSchemaVersion: ANALYSIS_INPUT_SCHEMA_VERSION,
      studyConfig: study.config,
      studyRevision: study.revision,
      requestedProvider: provider,
      requestedModel: model,
    },
  };
}

// ---------- Held durable workspace (Cloudflare target) ----------

/**
 * Public reason codes for a held workspace. `maintenance` is an operator
 * state (draining/frozen/recovery) expected to clear; `workspace-unavailable`
 * covers identity, recovery-epoch, schema and uninitialized holds, which need
 * operator action. Internal hold reasons are never exposed.
 */
export type WorkspaceHoldPublicReason = 'maintenance' | 'workspace-unavailable';

const HOLD_LOG_REASON: Record<WorkspaceHoldReason, RequestLogReason> = {
  maintenance: 'maintenance-hold',
  'schema-unsupported': 'schema-unsupported',
  'workspace-identity-mismatch': 'workspace-identity-mismatch',
  'workspace-uninitialized': 'not-configured',
  'recovery-epoch-mismatch': 'epoch-mismatch',
};

export function workspaceHoldPublicReason(reason: WorkspaceHoldReason): WorkspaceHoldPublicReason {
  return reason === 'maintenance' ? 'maintenance' : 'workspace-unavailable';
}

/** Copy for a held workspace: one message per public reason. */
export type WorkspaceHeldCopy = {
  /** Shown for `maintenance` (and for every hold when `unavailableError` is absent). */
  error: string;
  /** Shown for `workspace-unavailable` holds, which need operator action. */
  unavailableError?: string;
  retryable?: boolean;
};

/**
 * 503 for a held workspace. `retryable` defaults to true only for
 * maintenance; callers whose client must keep unsaved data (save) pass true.
 */
export function workspaceHeldResponse(input: WorkspaceHeldCopy & {
  route: string;
  reason: WorkspaceHoldReason;
  body?: Record<string, unknown>;
}): NextResponse {
  const known = Object.prototype.hasOwnProperty.call(HOLD_LOG_REASON, input.reason);
  const reason: WorkspaceHoldReason = known ? input.reason : 'workspace-identity-mismatch';
  const publicReason = workspaceHoldPublicReason(reason);
  logRequestEvent({ event: 'workspace.store', route: input.route, status: 503, reason: HOLD_LOG_REASON[reason] });
  return NextResponse.json(
    {
      ...input.body,
      error: publicReason === 'maintenance' ? input.error : input.unavailableError ?? input.error,
      retryable: input.retryable ?? reason === 'maintenance',
      reason: publicReason,
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

// Participant-facing copy never mentions the workspace or its operator.
export const PARTICIPANT_INTERVIEW_HELD_COPY: WorkspaceHeldCopy = {
  error: 'This interview is paused for maintenance. Please try again later.',
  unavailableError: 'This interview is unavailable right now. Please contact the researcher.',
};

export const PARTICIPANT_CONSENT_HELD_COPY: WorkspaceHeldCopy = {
  error: 'Consent cannot be recorded right now. Please try again later.',
  unavailableError: 'Consent cannot be recorded because this study is unavailable. Please contact the researcher.',
};

// The participant keeps the transcript and retries once the workspace reopens,
// so every save hold is retryable.
export const PARTICIPANT_SAVE_HELD_COPY: WorkspaceHeldCopy = {
  error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
  retryable: true,
};

/** Researcher-facing copy: maintenance clears; other holds need the operator. */
export function researcherHeldCopy(action: string): WorkspaceHeldCopy {
  return {
    error: `${action} while this workspace is under maintenance.`,
    unavailableError: `${action} because this workspace is unavailable. Its operator must restore it.`,
  };
}

/**
 * The refusal for a participant or preview request whose context could not be
 * resolved. A 503 forwards the resolver's `retryable`; a durable workspace
 * hold reported by the resolver (`holdReason`) is mapped like every other
 * held outcome, with the route's copy and only the public reason.
 */
export function participantContextRefusal(
  result: { error?: string; statusCode?: number; retryable?: boolean; holdReason?: WorkspaceHoldReason },
  input: { route: string; error: string; held: WorkspaceHeldCopy },
): NextResponse {
  if (result.holdReason !== undefined) {
    return workspaceHeldResponse({ route: input.route, reason: result.holdReason, ...input.held });
  }
  const status = result.statusCode ?? 401;
  return NextResponse.json(
    {
      error: result.error || input.error,
      ...(status === 503 && result.retryable !== undefined ? { retryable: result.retryable } : {}),
    },
    { status },
  );
}

/**
 * Greeting/interview admission through the request's workspace store with
 * the limiter's responses (401 incomplete authority, 403 subrequest, 429
 * limited, 503 unusable limiter), except that a store hold (frozen,
 * recovery, epoch/identity/uninitialized) is a held workspace, not a limiter
 * failure.
 */
export async function participantStoreAdmission(input: {
  request: Request;
  route: string;
  studyId: string;
  operation: 'greeting' | 'interview';
  store: Pick<WorkspaceStorePort, 'admitParticipantRequest'>;
  authority: Parameters<typeof participantStoreAdmissionResponse>[4];
}): Promise<NextResponse | null> {
  const observed: { hold?: WorkspaceHoldReason } = {};
  const limited = await participantStoreAdmissionResponse(
    input.request,
    input.studyId,
    input.operation,
    {
      admitParticipantRequest: async (admission) => {
        const outcome = await input.store.admitParticipantRequest(admission);
        if (outcome.status === 'held') observed.hold = outcome.reason;
        return outcome;
      },
    },
    input.authority,
  );
  if (observed.hold !== undefined) {
    return workspaceHeldResponse({ route: input.route, reason: observed.hold, ...PARTICIPANT_INTERVIEW_HELD_COPY });
  }
  return limited;
}

/**
 * Researcher preview is a paid no-write call (gap review F26): allowed while
 * the durable workspace is open or draining, refused while frozen, in
 * recovery or otherwise held. Always null for the Redis store.
 */
export async function researcherPreviewHoldResponse(
  store: WorkspaceStorePort,
  route: string,
): Promise<NextResponse | null> {
  if (!isDurableWorkspaceStore(store)) return null;
  const copy: WorkspaceHeldCopy = {
    error: 'Researcher preview is unavailable while this workspace is under maintenance.',
    unavailableError: 'Researcher preview cannot run because this workspace is unavailable. Its operator must restore it.',
  };
  let readiness: Awaited<ReturnType<WorkspaceStorePort['readiness']>>;
  try {
    readiness = await store.readiness();
  } catch {
    readiness = { status: 'unavailable' };
  }
  if (readiness.status === 'ready') {
    if (readiness.maintenance === 'open' || readiness.maintenance === 'draining') return null;
    return workspaceHeldResponse({ route, reason: 'maintenance', ...copy });
  }
  if (readiness.status === 'held') return workspaceHeldResponse({ route, reason: readiness.reason, ...copy });
  logRequestEvent({ event: 'workspace.store', route, status: 503, reason: 'unavailable' });
  return NextResponse.json(
    { error: 'Study storage is temporarily unavailable. Please try again.', retryable: true },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
