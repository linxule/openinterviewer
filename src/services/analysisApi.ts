import type { InterviewAnalysisFailureKind } from '@/types';

export type InterviewAnalysisOutcome =
  | { status: 'complete' | 'already-complete' | 'busy' }
  | { status: 'failed'; failureKind: InterviewAnalysisFailureKind };

export type AnalyzeInterviewResult =
  | { ok: true; outcome: InterviewAnalysisOutcome }
  | { ok: false; error: string; kind: 'request' | 'pending' };

const FAILURE_KINDS = new Set<InterviewAnalysisFailureKind>([
  'provider', 'invalid-output', 'too-large', 'timeout', 'storage',
]);

/** Only stored analysis outcomes cross this boundary; request failures are separate. */
export async function analyzeInterview(interviewId: string, studyId: string): Promise<AnalyzeInterviewResult> {
  try {
    const response = await fetch(
      `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`,
      { method: 'POST' },
    );
    const data: unknown = await response.json().catch(() => null);
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : null;

    if (!response.ok) {
      if (response.status === 409 && body?.code === 'STUDY_OPERATION_PENDING') {
        return { ok: false, kind: 'pending', error: 'A study operation is already in progress. Try again after it finishes.' };
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
