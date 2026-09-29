// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ExplorationAnswer, ExplorationResponse } from '@/lib/exploration/types';
import { isCompleteExplorationInput, isDatasetSelection, isExplorationAnswer, isExplorationProviderPayload,
  isExplorationReservation, isExplorationResponse, isFailExplorationInput, isProviderExecution,
  parseDatasetSelection, parseExplorationAnswer, serializedBytes } from '@/lib/exploration/validation';

const digest = 'a'.repeat(64);
const response: ExplorationResponse = { answer: 'A provisional interpretation, not a prevalence estimate.',
  findings: [{ heading: 'Access', interpretation: 'Access may matter.', supporting: [{ interviewId: 'interview-a', turnIndex: 2,
    quote: 'I could not open it.' }], challenging: [], uncertain: [] }], limitations: ['One synthetic source.'] };
const execution = { provider: 'gemini' as const, requestedModel: 'fixture-requested', model: 'fixture-served' };
const answer: ExplorationAnswer = { id: 'answer-a', studyId: 'study-a', question: 'What challenged access?', createdAt: 1,
  updatedAt: 1, status: 'running', requestFingerprint: digest, promptVersion: 1,
  scope: { studyId: 'study-a', selection: {}, sources: [{ interviewId: 'interview-a', studyRevision: 1, contentHash: digest }],
    totalSaved: 1, selectedCount: 1, excludedCount: 0, unknownProfileCount: 0, pendingAnalysisCount: 1, sourceFingerprint: digest },
};

describe('portable closed exploration validators', () => {
  it('rejects unbounded, duplicate, unknown or malformed selection inputs before any storage/provider work', () => {
    for (const value of [null, [], { all: true }, { interviewIds: ['a', 'a'] }, { interviewIds: ['../a'] },
      { revisions: [0] }, { revisions: [1, 1] }, { filters: [{ fieldId: 'age', operator: 'number-between', minimum: 30, maximum: 20 }] },
      { filters: [{ fieldId: 'age', operator: 'equals', value: '29', infer: true }] },
      { interviewIds: Array.from({ length: 101 }, (_, index) => `i-${index}`) }]) {
      expect(isDatasetSelection(value)).toBe(false);
      expect(parseDatasetSelection(value)).toBeNull();
    }
    expect(parseDatasetSelection({ interviewIds: [], revisions: [], filters: [] })).toEqual({ interviewIds: [], revisions: [], filters: [] });
  });

  it('checks attempt state and study/scope identity rather than merely accepting JSON', () => {
    expect(isExplorationReservation({ answer, keyDigest: digest, expectedStudyRevision: 1 })).toBe(true);
    expect(isExplorationAnswer({ ...answer, status: 'complete', result: response, execution })).toBe(true);
    expect(isExplorationAnswer({ ...answer, status: 'complete', result: response })).toBe(false);
    expect(isExplorationReservation({ answer: { ...answer, status: 'complete', result: response, execution },
      keyDigest: digest, expectedStudyRevision: 1 })).toBe(false);
    expect(isExplorationAnswer({ ...answer, scope: { ...answer.scope, studyId: 'other-study' } })).toBe(false);
    expect(isExplorationAnswer({ ...answer, scope: { ...answer.scope, selectedCount: 0, sources: [], excludedCount: 1 } })).toBe(false);
    expect(isExplorationAnswer({ ...answer, question: 'x'.repeat(2001) })).toBe(false);
    expect(isExplorationAnswer({ ...answer, status: 'recovery-required', failureKind: 'timeout' })).toBe(true);
    expect(isExplorationAnswer({ ...answer, status: 'failed' })).toBe(false);
  });

  it('refuses citations to records outside immutable scope but keeps unresolved claims honest', () => {
    const complete = { ...answer, status: 'complete', execution, result: response };
    expect(isExplorationAnswer(complete)).toBe(true);
    const unknownRef = { ...response, findings: [{ ...response.findings[0], supporting: [{ quote: 'Claimed quote', turnIndex: 2 }] }] };
    expect(isExplorationAnswer({ ...complete, result: unknownRef })).toBe(true);
    const foreignRef = { ...response, findings: [{ ...response.findings[0], supporting: [{ interviewId: 'other-record', quote: 'Claimed quote', turnIndex: 2 }] }] };
    expect(isExplorationAnswer({ ...complete, result: foreignRef })).toBe(false);
    expect(parseExplorationAnswer({ ...complete, extra: 'unchecked' })).toBeNull();
  });

  it('validates exact provenance and closed completion/failure operation shapes', () => {
    expect(isProviderExecution(execution)).toBe(true);
    expect(isProviderExecution({ ...execution, aiTransport: 'cloudflare-gateway' })).toBe(true);
    expect(isProviderExecution({ ...execution, aiTransport: 'direct' })).toBe(false);
    expect(isProviderExecution({ ...execution, model: '' })).toBe(false);
    const complete = { studyId: 'study-a', answerId: 'answer-a', requestFingerprint: digest, result: response, execution, now: 2 };
    expect(isCompleteExplorationInput(complete)).toBe(true);
    expect(isCompleteExplorationInput({ ...complete, now: NaN })).toBe(false);
    expect(isCompleteExplorationInput({ ...complete, receipt: 'arbitrary-browser-authority' })).toBe(false);
    expect(isFailExplorationInput({ studyId: 'study-a', answerId: 'answer-a', requestFingerprint: digest,
      status: 'recovery-required', failureKind: 'network', now: 2 })).toBe(true);
  });

  it('enforces UTF-8 serialized result cap and bounded position claims without trusting model IDs', () => {
    expect(isExplorationResponse(response)).toBe(true);
    const payload = { ...response, findings: [{ ...response.findings[0], supporting: [{ interviewIndex: 1, turnIndex: 2, quote: 'A quote.' }] }] };
    expect(isExplorationProviderPayload(payload)).toBe(true);
    expect(isExplorationProviderPayload({ ...payload, findings: [{ ...payload.findings[0], supporting: [{ interviewIndex: 0, turnIndex: 2, quote: 'A quote.' }] }] })).toBe(false);
    expect(isExplorationProviderPayload(response)).toBe(false);
    const oversized = { answer: 'A bounded narrative.', limitations: [], findings: Array.from({ length: 20 }, () => ({
      heading: 'Concern', interpretation: 'Recorded limitation.', supporting: Array.from({ length: 10 }, () => ({
        quote: '汉'.repeat(2000), turnIndex: 1, interviewId: 'interview-a',
      })), challenging: [], uncertain: [],
    })) };
    expect(serializedBytes(oversized)).toBeGreaterThan(128 * 1024);
    expect(isExplorationResponse(oversized)).toBe(false);
  });
});
