import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askStudyQuestion, describeStudyDataset, listStudyExplorations, listStudyExplorationsPage, saveStudyExploration } from '@/services/explorationApi';
import type { ExplorationAnswer } from '@/lib/exploration/types';

const scope = { studyId: 'study-api', selection: {}, sources: [{ interviewId: 'source-a', studyRevision: 1, contentHash: 'a'.repeat(64) }], totalSaved: 1, selectedCount: 1, excludedCount: 0, unknownProfileCount: 0, pendingAnalysisCount: 1, sourceFingerprint: 'b'.repeat(64) };
const answer: ExplorationAnswer = { id: 'answer-api', studyId: scope.studyId, question: 'What is supported?', scope, createdAt: 100, updatedAt: 101, status: 'complete', requestFingerprint: 'c'.repeat(64), promptVersion: 1, execution: { provider: 'gemini', requestedModel: 'fixture', model: 'fixture' }, result: { answer: 'A bounded answer.', findings: [], limitations: ['One source.'] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => vi.unstubAllGlobals());

describe('strict exploration browser API', () => {
  it('does not interpret malformed, foreign or HTTP error answers as successful research', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ answers: [{ ...answer, studyId: 'foreign' }] })).mockResolvedValueOnce(json({ answer: { ...answer, result: { answer: 'Invented fallback.' } } })).mockResolvedValueOnce(json({ answer, error: 'Service unavailable.' }, 503));
    vi.stubGlobal('fetch', fetch);
    await expect(listStudyExplorations(scope.studyId)).rejects.toThrow('The saved answers could not be confirmed.');
    await expect(askStudyQuestion(scope.studyId, { question: answer.question, selection: {} }, 'key-a')).rejects.toThrow('unreadable answer');
    await expect(askStudyQuestion(scope.studyId, { question: answer.question, selection: {} }, 'key-a')).rejects.toThrow('Service unavailable.');
  });

  it('preserves explicit selection and the same replay key; saving calls only the save route', async () => {
    const fetch = vi.fn(async () => json({ answer })); vi.stubGlobal('fetch', fetch);
    const input = { question: answer.question, selection: { revisions: [1], interviewIds: ['source-a'] } };
    await askStudyQuestion(scope.studyId, input, 'same-attempt'); await askStudyQuestion(scope.studyId, input, 'same-attempt');
    const first = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(fetch.mock.calls[1]).toEqual(first);
    expect(first[1].headers).toEqual({ 'Content-Type': 'application/json', 'Idempotency-Key': 'same-attempt' });
    expect(JSON.parse(first[1].body as string)).toEqual(input);
    await saveStudyExploration(scope.studyId, answer.id, 'signed-save-only');
    expect(fetch).toHaveBeenLastCalledWith(`/api/studies/${scope.studyId}/exploration/${answer.id}/save`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ receipt: 'signed-save-only' }) }));
  });

  it('refuses a malformed dataset manifest rather than displaying fictional coverage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ dataset: { manifest: { ...scope, selectedCount: 99 }, revisions: [], profileFields: [], historicalProfileUnknownCount: 0 } })));
    await expect(describeStudyDataset(scope.studyId)).rejects.toThrow('The dataset description could not be confirmed.');
  });

  it('exposes an explicit next-page cursor and escapes it on the next read', async () => {
    const fetch = vi.fn(async () => json({ answers: [answer], nextCursor: '100:answer-api' })); vi.stubGlobal('fetch', fetch);
    const page = await listStudyExplorationsPage(scope.studyId);
    expect(page.nextCursor).toBe('100:answer-api');
    await listStudyExplorationsPage(scope.studyId, page.nextCursor!);
    expect(fetch).toHaveBeenLastCalledWith(`/api/studies/${scope.studyId}/exploration?cursor=100%3Aanswer-api`, expect.any(Object));
  });
});
