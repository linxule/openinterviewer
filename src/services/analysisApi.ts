import type { InterviewAnalysisFailureKind } from '@/types';
import type { AnalysisPhase, AnalysisStatusBody } from '@/lib/storage/analysisProtocol';
import { UUID_V4 } from '@/lib/uuid';

export type InterviewAnalysisOutcome =
  | { status: 'complete' | 'already-complete' | 'busy' }
  | { status: 'failed'; failureKind: InterviewAnalysisFailureKind };

export type AnalyzeInterviewResult =
  | { ok: true; outcome: InterviewAnalysisOutcome }
  | { ok: false; error: string; kind: 'request' | 'pending' | 'update-required' };

const FAILURE_KINDS = new Set<InterviewAnalysisFailureKind>([
  'provider', 'invalid-output', 'too-large', 'timeout', 'storage',
]);

const UPDATE_REQUIRED_MESSAGE = 'Reload this page to analyze interviews.';

function analyzeUrl(interviewId: string, studyId: string): string {
  return `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`;
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  const data: unknown = await response.json().catch(() => null);
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
}

/**
 * Legacy synchronous analysis (Node). Only stored analysis outcomes cross this
 * boundary; request failures are separate.
 */
export async function analyzeInterview(interviewId: string, studyId: string): Promise<AnalyzeInterviewResult> {
  try {
    const response = await fetch(analyzeUrl(interviewId, studyId), { method: 'POST' });
    const body = await readBody(response);

    if (!response.ok) {
      if (response.status === 409 && body?.code === 'STUDY_OPERATION_PENDING') {
        return { ok: false, kind: 'pending', error: 'A study operation is already in progress. Try again after it finishes.' };
      }
      // A durable-analysis server refuses unversioned requests before any work.
      if (response.status === 409 && body?.code === 'ANALYSIS_CLIENT_UPDATE_REQUIRED') {
        return { ok: false, kind: 'update-required', error: UPDATE_REQUIRED_MESSAGE };
      }
      if (response.status === 429) {
        return { ok: false, kind: 'request', error: 'The analysis request limit has been reached. Wait before trying again.' };
      }
      if (response.status === 503) {
        return { ok: false, kind: 'request', error: 'Analysis is temporarily unavailable. Please try again.' };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, kind: 'request', error: 'Analysis could not be authorized. Reload the page and sign in if needed.' };
      }
      return { ok: false, kind: 'request', error: 'The analysis request could not be completed. Please try again.' };
    }

    if (body?.status === 'complete' || body?.status === 'already-complete' || body?.status === 'busy') {
      return { ok: true, outcome: { status: body.status } };
    }
    if (body?.status === 'failed' && FAILURE_KINDS.has(body.failureKind as InterviewAnalysisFailureKind)) {
      return { ok: true, outcome: { status: 'failed', failureKind: body.failureKind as InterviewAnalysisFailureKind } };
    }
    return { ok: false, kind: 'request', error: 'The analysis result could not be confirmed. Reload the page before trying again.' };
  } catch {
    return { ok: false, kind: 'request', error: 'The analysis request could not reach the server. Check your connection and try again.' };
  }
}

// ---------- Durable analysis (v2): 03-analysis-jobs.md API-01..API-03 ----------

export const ANALYSIS_API_VERSION = '2';

export type AnalysisRequestFailureKind =
  | 'pending'          // 409 STUDY_OPERATION_PENDING
  | 'update-required'  // 409 ANALYSIS_CLIENT_UPDATE_REQUIRED: this page predates the server
  | 'state-changed'    // 409 ANALYSIS_STATE_CHANGED: refresh before another action
  | 'key-conflict'     // 409 ANALYSIS_REQUEST_KEY_CONFLICT
  | 'not-found'        // 404
  | 'unauthorized'     // 401 / 403
  | 'rate-limited'     // 429
  | 'unavailable'      // 503, retryable
  | 'network'          // no response
  | 'unconfirmed'      // 2xx outside the closed projection
  | 'request';         // any other refusal

export type AnalysisRequestFailure = {
  ok: false;
  kind: AnalysisRequestFailureKind;
  /**
   * The server may have committed the request. Retry the same intentional
   * action with the same key and body; never treat it as a refusal.
   */
  uncertain: boolean;
  error: string;
};

export type AnalysisStatusResult =
  | { ok: true; outcome: AnalysisStatusBody }
  | AnalysisRequestFailure;

type Method = 'POST' | 'GET';

const START_MESSAGES: Record<AnalysisRequestFailureKind, string> = {
  pending: 'A study operation is already in progress. Try again after it finishes.',
  'update-required': UPDATE_REQUIRED_MESSAGE,
  'state-changed': 'This interview’s analysis changed since the page loaded. Check its latest status before running it again.',
  'key-conflict': 'This analysis request could not be matched to the earlier attempt. Reload the page before trying again.',
  'not-found': 'This interview could not be found. It may have been deleted.',
  unauthorized: 'Analysis could not be authorized. Reload the page and sign in if needed.',
  'rate-limited': 'The analysis request limit has been reached. Wait before trying again.',
  unavailable: 'Analysis is temporarily unavailable. Please try again.',
  network: 'The analysis request could not reach the server. Check your connection and try again.',
  unconfirmed: 'The analysis result could not be confirmed. Reload the page before trying again.',
  request: 'The analysis request could not be completed. Please try again.',
};

const STATUS_MESSAGES: Record<AnalysisRequestFailureKind, string> = {
  pending: 'A study operation is already in progress. Check again after it finishes.',
  'update-required': UPDATE_REQUIRED_MESSAGE,
  'state-changed': 'The latest analysis status could not be checked. Try again.',
  'key-conflict': 'The latest analysis status could not be checked. Try again.',
  'not-found': 'This interview could not be found. It may have been deleted.',
  unauthorized: 'The analysis status could not be authorized. Reload the page and sign in if needed.',
  'rate-limited': 'The analysis status was checked too often. Wait before checking again.',
  unavailable: 'The analysis status is temporarily unavailable. Try again shortly.',
  network: 'The analysis status could not be checked. Check your connection and try again.',
  unconfirmed: 'The analysis status could not be confirmed. Try again.',
  request: 'The analysis status could not be checked. Try again.',
};

function failure(method: Method, kind: AnalysisRequestFailureKind, uncertain: boolean): AnalysisRequestFailure {
  return {
    ok: false,
    kind,
    // A read never commits anything; only an unconfirmed start is uncertain.
    uncertain: method === 'POST' && uncertain,
    error: (method === 'POST' ? START_MESSAGES : STATUS_MESSAGES)[kind],
  };
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const PHASES = new Set<AnalysisPhase>(['queued', 'running', 'not-scheduled']);

/**
 * Parse the closed projection field by field. Nothing but these fields ever
 * leaves this function; server text is never passed through.
 */
function parseStatusBody(body: Record<string, unknown> | null, method: Method): AnalysisStatusBody | null {
  if (!body || !isGeneration(body.generation)) return null;
  const generation = body.generation;
  switch (body.status) {
    case 'pending': {
      const phase = body.phase as AnalysisPhase;
      if (!PHASES.has(phase)) return null;
      // Unscheduled legacy work exists only at generation 0, and only a read
      // reports it; accepted work always has a generation of its own.
      if ((phase === 'not-scheduled') !== (generation === 0)) return null;
      if (phase === 'not-scheduled' && method === 'POST') return null;
      const pollAfterMs = typeof body.pollAfterMs === 'number' && Number.isFinite(body.pollAfterMs)
        ? body.pollAfterMs
        : undefined;
      return pollAfterMs === undefined
        ? { status: 'pending', generation, phase }
        : { status: 'pending', generation, phase, pollAfterMs };
    }
    case 'complete':
    case 'already-complete':
      return { status: body.status, generation };
    case 'failed':
      if (!FAILURE_KINDS.has(body.failureKind as InterviewAnalysisFailureKind)) return null;
      if (typeof body.recoveryRequired !== 'boolean') return null;
      return {
        status: 'failed',
        generation,
        failureKind: body.failureKind as InterviewAnalysisFailureKind,
        recoveryRequired: body.recoveryRequired,
      };
    default:
      return null;
  }
}

function classifyRefusal(
  status: number,
  body: Record<string, unknown> | null,
  method: Method,
): AnalysisRequestFailure {
  if (status === 409) {
    switch (body?.code) {
      case 'STUDY_OPERATION_PENDING': return failure(method, 'pending', false);
      case 'ANALYSIS_CLIENT_UPDATE_REQUIRED': return failure(method, 'update-required', false);
      case 'ANALYSIS_STATE_CHANGED': return failure(method, 'state-changed', false);
      case 'ANALYSIS_REQUEST_KEY_CONFLICT': return failure(method, 'key-conflict', false);
      default: return failure(method, 'request', false);
    }
  }
  if (status === 404) return failure(method, 'not-found', false);
  if (status === 401 || status === 403) return failure(method, 'unauthorized', false);
  if (status === 429) return failure(method, 'rate-limited', false);
  // Unknown allocation commit is 503 retryable; any other server error could
  // equally have committed before failing.
  if (status === 503) return failure(method, 'unavailable', true);
  return failure(method, 'request', status >= 500);
}

async function requestStatus(
  method: Method,
  url: string,
  init: RequestInit,
): Promise<AnalysisStatusResult> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return failure(method, 'network', true);
  }
  const body = await readBody(response);
  if (!response.ok) return classifyRefusal(response.status, body, method);
  const outcome = parseStatusBody(body, method);
  return outcome ? { ok: true, outcome } : failure(method, 'unconfirmed', true);
}

export type StartInterviewAnalysisInput = {
  studyId: string;
  interviewId: string;
  /** The generation of the last confirmed state this action was taken on. */
  expectedGeneration: number;
  /** One key per intentional action, reused for every retry of that action. */
  idempotencyKey: string;
  signal?: AbortSignal;
};

export async function startInterviewAnalysisV2(input: StartInterviewAnalysisInput): Promise<AnalysisStatusResult> {
  if (!isGeneration(input.expectedGeneration) || !UUID_V4.test(input.idempotencyKey)) {
    return failure('POST', 'request', false);
  }
  return requestStatus('POST', analyzeUrl(input.interviewId, input.studyId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenInterviewer-Analysis-Version': ANALYSIS_API_VERSION,
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({ expectedGeneration: input.expectedGeneration }),
    cache: 'no-store',
    signal: input.signal,
  });
}

/** Read-only: never allocates, dispatches or retries on the server. */
export async function getInterviewAnalysisStatus(input: {
  studyId: string;
  interviewId: string;
  signal?: AbortSignal;
}): Promise<AnalysisStatusResult> {
  return requestStatus('GET', analyzeUrl(input.interviewId, input.studyId), {
    method: 'GET',
    cache: 'no-store',
    signal: input.signal,
  });
}
