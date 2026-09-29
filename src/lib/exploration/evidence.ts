// Coordinates are claims. Verification and exact displayed characters always
// come from the selected source record, never a persisted model verdict.
import type { EvidenceRef, StoredInterview } from '@/types';
import { resolveEvidenceRef, type EvidenceMatch } from '@/lib/evidence';
import type { DatasetManifest, ExplorationProviderPayload, ExplorationResponse } from './types';
import { immutableSourceContentHash } from './dataset';

/** Map model-local 1-based positions to server-owned identities, preserving claims. */
export function resolveExplorationPayload(
  payload: ExplorationProviderPayload,
  interviews: StoredInterview[],
): ExplorationResponse {
  const resolve = (claim: { interviewIndex: number; turnIndex: number; quote: string }): EvidenceRef => {
    const interview = interviews[claim.interviewIndex - 1];
    return {
      quote: claim.quote,
      turnIndex: claim.turnIndex,
      ...(interview ? { interviewId: interview.id } : {}),
    };
  };
  return {
    answer: payload.answer,
    findings: payload.findings.map(finding => ({
      heading: finding.heading,
      interpretation: finding.interpretation,
      supporting: finding.supporting.map(resolve),
      challenging: finding.challenging.map(resolve),
      uncertain: finding.uncertain.map(resolve),
    })),
    limitations: [...payload.limitations],
  };
}

export interface ExplorationEvidenceEntry {
  ref: EvidenceRef;
  match: EvidenceMatch;
  /** null for unverifiable claims; verified excerpts use original characters. */
  quotedFromRecord: string | null;
}

/** An absent record or identity is never filled in from another interview. */
export function resolveExplorationEvidenceRef(
  ref: EvidenceRef,
  interviews: readonly StoredInterview[],
  studyId?: string,
): ExplorationEvidenceEntry {
  const record = typeof ref?.interviewId === 'string'
    ? interviews.find(interview => interview.id === ref.interviewId && (!studyId || interview.studyId === studyId))
    : undefined;
  if (!record) return { ref, match: { status: 'unverified', reason: 'no-record' }, quotedFromRecord: null };
  const match = resolveEvidenceRef(ref, record.transcript);
  return {
    ref, match,
    quotedFromRecord: match.status === 'verified'
      ? match.spans.map(span => record.transcript[match.turnIndex - 1].content.slice(span.start, span.end)).join('\u200a…\u200a')
      : null,
  };
}

/** Counts describe located citations, not prevalence or the validity of interpretation. */
export function summarizeExplorationEvidence(
  response: ExplorationResponse,
  interviews: readonly StoredInterview[],
  studyId?: string,
): {
  entries: ExplorationEvidenceEntry[];
  verifiedQuoteCount: number;
  unverifiedQuoteCount: number;
  quotedInterviewIds: string[];
} {
  const entries = response.findings.flatMap(finding => [...finding.supporting, ...finding.challenging, ...finding.uncertain])
    .map(ref => resolveExplorationEvidenceRef(ref, interviews, studyId));
  const verified = entries.filter(entry => entry.match.status === 'verified');
  return {
    entries,
    verifiedQuoteCount: verified.length,
    unverifiedQuoteCount: entries.length - verified.length,
    quotedInterviewIds: [...new Set(verified.flatMap(entry => entry.ref.interviewId ? [entry.ref.interviewId] : []))].sort(),
  };
}

/**
 * Historical answers can remain readable after new collection. A citation may
 * only resolve against the exact immutable record that belonged to its scope.
 * Changed/missing records are not returned as trusted evidence.
 */
export async function resolveManifestSources(
  manifest: DatasetManifest,
  interviews: readonly StoredInterview[],
): Promise<{ interviews: StoredInterview[]; unavailableInterviewIds: string[] }> {
  const matching: StoredInterview[] = [];
  const unavailableInterviewIds: string[] = [];
  for (const source of manifest.sources) {
    const interview = interviews.find(record => record.id === source.interviewId && record.studyId === manifest.studyId);
    if (!interview) { unavailableInterviewIds.push(source.interviewId); continue; }
    try {
      if (await immutableSourceContentHash(interview) !== source.contentHash) {
        unavailableInterviewIds.push(source.interviewId);
      } else matching.push(interview);
    } catch {
      unavailableInterviewIds.push(source.interviewId);
    }
  }
  return { interviews: matching, unavailableInterviewIds };
}
