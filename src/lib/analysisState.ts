import type { InterviewAnalysisStatus, StoredInterview } from '@/types';

/**
 * The one derivation of an interview's analysis state. Legacy records carry no
 * `analysis` member; their status is read off the synthesis the server itself
 * wrote — a stored fact about the record, not an inference from another one.
 * Every read surface calls this. No component reimplements the derivation,
 * and no component reads `interview.analysis?.status` directly.
 */
export function analysisStatus(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): InterviewAnalysisStatus {
  return interview.analysis ? interview.analysis.status : interview.synthesis ? 'complete' : 'pending';
}

/** True for pending, running and failed. */
export function isAwaitingAnalysis(
  interview: Pick<StoredInterview, 'analysis' | 'synthesis'>,
): boolean {
  return analysisStatus(interview) !== 'complete';
}
