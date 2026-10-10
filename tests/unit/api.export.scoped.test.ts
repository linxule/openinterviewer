// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { ExplorationAnswer } from '@/lib/exploration/types';
import type { DurableWorkspaceStorePort, WorkspaceStorePort } from '@/lib/storage/types';
import { createInterviewExportStream } from '@/lib/export/interviewExport';
import { exportAllInterviewsChecked, isCompleteZipArchive } from '@/services/storageService';

const access = vi.hoisted(() => ({ getAuthorizedResearcherStudyContext: vi.fn(), getRequestContext: vi.fn(), getHostedResearcherIdentity: vi.fn() }));
vi.mock('@/lib/researcherContext', () => access);
vi.mock('@/lib/mode', () => ({ isHostedMode: () => false }));
import { GET } from '@/app/api/interviews/export/route';

function answer(studyId = 'study-a'): ExplorationAnswer {
  return {
    id: 'answer-a', studyId, question: 'What challenges the hypothesis?', status: 'complete',
    scope: { studyId, selection: { revisions: [1] }, sources: [{ interviewId: 'interview-a', studyRevision: 1, contentHash: 'a'.repeat(64) }], totalSaved: 1, selectedCount: 1, excludedCount: 0, unknownProfileCount: 0, pendingAnalysisCount: 0, sourceFingerprint: 'b'.repeat(64) },
    createdAt: 1, updatedAt: 2, requestFingerprint: 'c'.repeat(64), promptVersion: 1,
    result: { answer: 'A source-bound answer.', findings: [], limitations: ['One interview.'] },
    execution: { provider: 'gemini', requestedModel: 'fixture', model: 'fixture' },
  };
}

const getStudy = vi.fn();
const listInterviews = vi.fn();
const getAggregate = vi.fn();
const listAnswers = vi.fn();
const store = {
  backend: 'redis', getStudy, listInterviews, getAggregate,
  exploration: { list: listAnswers },
} as unknown as WorkspaceStorePort;
const request = (id = 'study-a') => new Request(`http://localhost/api/interviews/export?studyId=${encodeURIComponent(id)}`);

beforeEach(() => {
  vi.clearAllMocks();
  getStudy.mockResolvedValue({ status: 'found', study: makeStoredStudy({ id: 'study-a' }) });
  listInterviews.mockResolvedValue({ status: 'ok', items: [makeStoredInterview({ id: 'interview-a', studyId: 'study-a' })] });
  getAggregate.mockResolvedValue({ status: 'not-found' });
  listAnswers.mockResolvedValue({ status: 'ok', answers: [answer()] });
  access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store } });
});

describe('study-scoped export', () => {
  it('has byte-identical analysis entries through the actual scoped Node and durable routes', async () => {
    const interviews = [makeStoredInterview({ id: 'interview-a', studyId: 'study-a', studyRevision: 1,
      collectionConfig: makeStudyConfig({ interviewLanguages: ['fr', 'zh'] }), interviewLanguage: 'fr' })];
    listInterviews.mockResolvedValue({ status: 'ok', items: interviews });
    const node = await GET(request());
    const nodeZip = await JSZip.loadAsync(await node.arrayBuffer(), { checkCRC32: true });
    const beginExport = vi.fn().mockResolvedValue({ status: 'ok', sequence: 3, count: 1, studyIds: ['study-a'] });
    const readExportPage = vi.fn().mockImplementation(async ({ cursor }) => cursor === null
      ? { status: 'ok', interviews, aggregates: [], nextCursor: 'notebook' }
      : { status: 'ok', interviews: [], aggregates: [], explorations: [answer()], nextCursor: null });
    const verifyExportSequence = vi.fn().mockResolvedValue('unchanged');
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: {
      ...store, backend: 'durable-object', beginExport, readExportPage, verifyExportSequence,
    } } });
    const durable = await GET(request());
    const durableZip = await JSZip.loadAsync(await durable.arrayBuffer(), { checkCRC32: true });
    const analysisNames = Object.keys(nodeZip.files).filter(name => name.startsWith('analysis/'));
    expect(Object.keys(durableZip.files).filter(name => name.startsWith('analysis/'))).toEqual(analysisNames);
    for (const name of analysisNames) {
      expect(await durableZip.files[name].async('uint8array'), name).toEqual(await nodeZip.files[name].async('uint8array'));
    }
    const records = (await durableZip.file('analysis/interviews.jsonl')!.async('string')).trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.study.id)).toEqual(['study-a']);
    expect(verifyExportSequence).toHaveBeenCalledWith({ sequence: 3, studyId: 'study-a' });
  });

  it('walks all notebook pages instead of silently exporting only the first 25 answers', async () => {
    listAnswers.mockResolvedValueOnce({ status: 'ok', answers: [answer()], nextCursor: '1:answer-a' })
      .mockResolvedValueOnce({ status: 'ok', answers: [{ ...answer(), id: 'answer-b' }], nextCursor: null });
    const response = await GET(request());
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file('explorations/study-a/answer-b.json')).not.toBeNull();
    expect(listAnswers).toHaveBeenNthCalledWith(2, { studyId: 'study-a', maximum: 500, pageSize: 25, cursor: '1:answer-a' });
  });

  it('refuses a notebook page walk that repeats a cursor or record', async () => {
    listAnswers.mockResolvedValue({ status: 'ok', answers: [answer()], nextCursor: '1:answer-a' });
    expect((await GET(request())).status).toBe(503);
  });

  it('refuses a completed ZIP if deletion starts or removes its parent during archive construction', async () => {
    for (const final of ['deleting', 'missing'] as const) {
      const status = vi.fn().mockResolvedValueOnce('ready').mockResolvedValue(final);
      access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: { ...store, studyMutationStatus: status } } });
      const response = await GET(request());
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect((await response.json()).code).toBe(final === 'deleting' ? 'STUDY_DELETION_PENDING' : 'EXPORT_CHANGED');
    }
  });

  it('does not read a partial deletion dataset at all', async () => {
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: { ...store, studyMutationStatus: vi.fn().mockResolvedValue('deleting') } } });
    const response = await GET(request());
    expect(response.status).toBe(409);
    expect(listInterviews).not.toHaveBeenCalled();
    expect(listAnswers).not.toHaveBeenCalled();
  });
  it('gates the exact study before loading data and exports its source records and saved notebook only', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(access.getAuthorizedResearcherStudyContext).toHaveBeenCalledWith('study-a', 'read');
    expect(access.getRequestContext).not.toHaveBeenCalled();
    expect(listInterviews).toHaveBeenCalledWith({ scope: 'study', studyId: 'study-a', maximum: 500 });
    expect(listAnswers).toHaveBeenCalledWith({ studyId: 'study-a', maximum: 500, pageSize: 25 });
    const archive = await response.blob();
    expect(await isCompleteZipArchive(archive)).toBe(true);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const exportedAnswer = JSON.parse(await zip.file('explorations/study-a/answer-a.json')!.async('string'));
    expect(exportedAnswer).toEqual(answer());
    expect(JSON.stringify(Object.keys(zip.files))).not.toContain('study-b');
  });

  it('refuses another researcher study before reading any transcripts or notebook', async () => {
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: false, statusCode: 403, error: 'Study ownership does not match this account' });
    expect((await GET(request())).status).toBe(403);
    expect(getStudy).not.toHaveBeenCalled();
    expect(listInterviews).not.toHaveBeenCalled();
    expect(listAnswers).not.toHaveBeenCalled();
  });

  it('refuses oversize studies instead of truncating or recommending a nonexistent selector', async () => {
    listInterviews.mockResolvedValue({ status: 'too-large', count: 501, maximum: 500 });
    const response = await GET(request());
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain('operator backup');
    expect(listAnswers).not.toHaveBeenCalled();
  });

  it('does not produce an apparently complete archive when saved notebook data cannot be read', async () => {
    listAnswers.mockResolvedValue({ status: 'unavailable' });
    expect((await GET(request())).status).toBe(503);
  });

  it('exports a notebook-only study rather than claiming there is no retained research data', async () => {
    listInterviews.mockResolvedValue({ status: 'ok', items: [] });
    const response = await GET(request());
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file('explorations/study-a/answer-a.json')).not.toBeNull();
  });

  it('propagates study scope through every durable snapshot operation', async () => {
    const beginExport = vi.fn().mockResolvedValue({ status: 'ok', sequence: 3, count: 0, studyIds: ['study-a'] });
    const readExportPage = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', interviews: [], aggregates: [], explorations: [answer()], nextCursor: 'next' })
      .mockResolvedValue({ status: 'ok', interviews: [], aggregates: [], explorations: [], nextCursor: null });
    const verifyExportSequence = vi.fn().mockResolvedValue('unchanged');
    const durable = { ...store, backend: 'durable-object', beginExport, readExportPage, verifyExportSequence } as unknown as DurableWorkspaceStorePort;
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: durable } });
    const response = await GET(request());
    expect(response.status).toBe(200);
    const archive = await response.blob();
    expect(await isCompleteZipArchive(archive)).toBe(true);
    expect(beginExport).toHaveBeenCalledWith({ maximum: 500, studyId: 'study-a' });
    expect(readExportPage).toHaveBeenCalledTimes(6);
    for (const [input] of readExportPage.mock.calls) expect(input.studyId).toBe('study-a');
    expect(verifyExportSequence).toHaveBeenCalledWith({ sequence: 3, studyId: 'study-a' });
  });

  it('preserves notebook archive content across both ZIP writers', async () => {
    const node = await GET(request());
    const nodeZip = await JSZip.loadAsync(await node.arrayBuffer());
    const interview = makeStoredInterview({ id: 'interview-a', studyId: 'study-a' });
    const streamed = createInterviewExportStream({ pages: async function* () { yield { interviews: [interview], aggregates: [], explorations: [answer()] }; } });
    const zip = await JSZip.loadAsync(await new Response(streamed).arrayBuffer());
    expect(await zip.file('explorations/study-a/answer-a.json')!.async('string')).toBe(await nodeZip.file('explorations/study-a/answer-a.json')!.async('string'));
  });

  it('uses the checked download route with an encoded study selector', async () => {
    const valid = new JSZip();
    valid.file('summary.csv', 'Header');
    const blob = await valid.generateAsync({ type: 'blob' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(blob));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect((await exportAllInterviewsChecked('study-a')).status).toBe('ok');
      expect(fetchMock).toHaveBeenCalledWith('/api/interviews/export?studyId=study-a');
    } finally { vi.unstubAllGlobals(); }
  });
});
