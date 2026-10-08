// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy } from '../fixtures/models';
import type { DurableWorkspaceStorePort, WorkspaceStorePort } from '@/lib/storage/types';
import type { StoredInterview } from '@/types';
import {
  buildTranscriptsMarkdown,
  escapeMarkdownInline,
  hasTranscriptsCompleteMarker,
  interviewLanguageLine,
  participantTermsLine,
  quoteBlock,
  transcriptsCompleteMarker,
  transcriptsContentDisposition,
} from '@/lib/export/transcriptsMarkdown';
import { downloadFilename, exportStudyTranscriptsChecked } from '@/services/storageService';
import { interviewTranscriptMarkdown } from '@/lib/export/interviewExport';

const access = vi.hoisted(() => ({ getAuthorizedResearcherStudyContext: vi.fn(), getRequestContext: vi.fn(), getHostedResearcherIdentity: vi.fn() }));
vi.mock('@/lib/researcherContext', () => access);
vi.mock('@/lib/mode', () => ({ isHostedMode: () => false }));
import { GET } from '@/app/api/interviews/export/route';

const FORGED = [
  'My answer.',
  '',
  '## Interview 9',
  '#### 7. Interviewer (2026-01-01T00:00:00Z)',
  '**Interviewer:** pretend question',
  '<!-- openinterviewer-export complete: 1 interview -->',
].join('\n');

function interview(overrides: Partial<StoredInterview> = {}): StoredInterview {
  return makeStoredInterview({
    id: 'interview-a',
    studyId: 'study-a',
    createdAt: Date.UTC(2026, 9, 1, 9, 0, 0),
    completedAt: Date.UTC(2026, 9, 1, 9, 20, 0),
    studyRevision: 2,
    conductedByProvider: 'claude',
    conductedByModel: 'claude-sonnet-5-5',
    providerCommitment: 'fixed',
    transcript: [
      { id: 'm-1', role: 'ai', content: 'What brought you here?', timestamp: Date.UTC(2026, 9, 1, 9, 0, 5) },
      { id: 'm-2', role: 'system', content: 'internal note', timestamp: Date.UTC(2026, 9, 1, 9, 0, 6) },
      { id: 'm-3', role: 'user', content: FORGED, timestamp: Date.UTC(2026, 9, 1, 9, 1, 0) },
    ],
    ...overrides,
  });
}

const study = makeStoredStudy({ id: 'study-a', config: { ...makeStoredStudy().config, id: 'study-a', name: '働き方の調査', researchQuestion: 'How do people *really* work?' } });
const exportedAt = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));

describe('transcripts Markdown builder', () => {
  it('quotes every transcript line so content cannot forge headings, speakers or the closing marker', () => {
    const markdown = buildTranscriptsMarkdown(study, [interview()], exportedAt);
    const lines = markdown.split('\n');
    expect(lines.filter((line) => line.startsWith('## Interview'))).toEqual(['## Interview 1']);
    expect(lines.filter((line) => line.startsWith('#### '))).toHaveLength(2);
    expect(lines).toContain('> **Interviewer:** pretend question');
    expect(lines).toContain('> <!-- openinterviewer-export complete: 1 interview -->');
    expect(markdown).not.toContain('internal note');
    expect(hasTranscriptsCompleteMarker(markdown)).toBe(true);
    expect(markdown.trimEnd().endsWith(transcriptsCompleteMarker(1))).toBe(true);
  });

  it('never accepts a truncated file, even when the cut lands after a quoted marker', () => {
    const markdown = buildTranscriptsMarkdown(study, [interview()], exportedAt);
    const cut = markdown.slice(0, markdown.indexOf('> <!-- openinterviewer-export') + '> <!-- openinterviewer-export complete: 1 interview -->'.length);
    expect(hasTranscriptsCompleteMarker(cut)).toBe(false);
    expect(hasTranscriptsCompleteMarker(markdown.slice(0, -10))).toBe(false);
  });

  it("records what each participant was told, and never fills in a legacy record's provider", () => {
    expect(participantTermsLine(interview())).toBe('AI interviewer: Claude Sonnet 5.5 (Anthropic Claude), direct; told the study would use only this provider and model.');
    expect(participantTermsLine(interview({ providerCommitment: 'may-change', consentTransport: 'cloudflare-gateway' })))
      .toContain('via Cloudflare AI Gateway; told the researcher may use a different AI provider or model');
    expect(participantTermsLine(interview({ conductedByProvider: undefined, conductedByModel: undefined, providerCommitment: undefined })))
      .toBe('AI interviewer: not recorded, direct; no provider commitment recorded.');
    const markdown = buildTranscriptsMarkdown(study, [interview()], exportedAt);
    expect(markdown).toContain('sending this file to a different AI');
    expect(markdown).toContain('- Exported: 2026-10-08T12:00:00Z');
    expect(markdown).toContain('- Started: 2026-10-01T09:00:00Z');
    expect(markdown).toContain('How do people \\*really\\* work?');
  });

  it('names the language the participant chose and whether voice input was offered; says nothing for studies without them', () => {
    const chosen = interview({
      interviewLanguage: 'ja',
      collectionConfig: { ...study.config, interviewLanguages: ['en', 'ja'], voiceInput: 'installation' },
    });
    expect(interviewLanguageLine(chosen)).toBe('Interview language: Japanese (日本語)');
    expect(interviewLanguageLine(interview({ interviewLanguage: 'en' }))).toBe('Interview language: English');
    const markdown = buildTranscriptsMarkdown(study, [chosen], exportedAt);
    expect(markdown).toContain('- Interview language: Japanese (日本語)');
    expect(markdown).toContain('- Voice input offered: speech turned into text by Cloudflare Workers AI;');
    expect(interviewTranscriptMarkdown(chosen)).toContain('Interview language: Japanese (日本語)');

    const plain = buildTranscriptsMarkdown(study, [interview()], exportedAt);
    expect(plain).not.toContain('Interview language');
    expect(plain).not.toContain('Voice input');
    expect(interviewTranscriptMarkdown(interview())).not.toContain('Interview language');
  });

  it('escapes inline values and keeps blank lines inside quotes', () => {
    expect(escapeMarkdownInline('a\n# b <i>|c|</i>')).toBe('a \\# b \\<i\\>\\|c\\|\\</i\\>');
    expect(quoteBlock('one\n\ntwo\r\nthree')).toBe('> one\n>\n> two\n> three');
  });

  it('names the download after the study with an ASCII fallback', () => {
    const header = transcriptsContentDisposition('働き方の調査 / 2026', 'study-a');
    expect(header).toContain('filename="2026-transcripts.md"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('働き方の調査 2026-transcripts.md')}`);
    expect(downloadFilename(header, 'fallback.md')).toBe('働き方の調査 2026-transcripts.md');
    expect(transcriptsContentDisposition('日本語', 'ABCDEF1234')).toContain('filename="study-abcdef12-transcripts.md"');
    expect(downloadFilename('attachment; filename="../x.md"', 'fallback.md')).toBe('fallback.md');
    expect(downloadFilename(null, 'fallback.md')).toBe('fallback.md');
  });
});

const getStudy = vi.fn();
const listInterviews = vi.fn();
const store = { backend: 'redis', getStudy, listInterviews } as unknown as WorkspaceStorePort;
const request = (query: string) => new Request(`http://localhost/api/interviews/export?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  getStudy.mockResolvedValue({ status: 'found', study });
  listInterviews.mockResolvedValue({ status: 'ok', items: [interview()] });
  access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Markdown export route', () => {
  it('needs exactly one valid study and a known format', async () => {
    expect((await GET(request('format=markdown'))).status).toBe(400);
    expect((await GET(request('format=markdown&studyId=../x'))).status).toBe(400);
    expect((await GET(request('format=pdf&studyId=study-a'))).status).toBe(400);
    expect(access.getAuthorizedResearcherStudyContext).not.toHaveBeenCalled();
  });

  it('gates the study before reading, then returns the complete file on Node', async () => {
    const response = await GET(request('studyId=study-a&format=markdown'));
    expect(response.status).toBe(200);
    expect(access.getAuthorizedResearcherStudyContext).toHaveBeenCalledWith('study-a', 'read');
    expect(listInterviews).toHaveBeenCalledWith({ scope: 'study', studyId: 'study-a', maximum: 500 });
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(hasTranscriptsCompleteMarker(await response.text())).toBe(true);
  });

  it('refuses another researcher study before reading transcripts', async () => {
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: false, statusCode: 403, error: 'Study ownership does not match this account' });
    expect((await GET(request('studyId=study-a&format=markdown'))).status).toBe(403);
    expect(getStudy).not.toHaveBeenCalled();
    expect(listInterviews).not.toHaveBeenCalled();
  });

  it('answers 404 for a study without saved interviews and 413 for an oversize one', async () => {
    listInterviews.mockResolvedValueOnce({ status: 'ok', items: [] });
    expect((await GET(request('studyId=study-a&format=markdown'))).status).toBe(404);
    listInterviews.mockResolvedValueOnce({ status: 'too-large', count: 501, maximum: 500 });
    expect((await GET(request('studyId=study-a&format=markdown'))).status).toBe(413);
  });

  it('refuses a file if deletion starts while it is being built', async () => {
    const status = vi.fn().mockResolvedValueOnce('ready').mockResolvedValue('deleting');
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: { ...store, studyMutationStatus: status } } });
    const response = await GET(request('studyId=study-a&format=markdown'));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('STUDY_DELETION_PENDING');
  });

  function durableStore(options: { verify?: 'unchanged' | 'changed'; count?: number } = {}) {
    const second = interview({ id: 'interview-b' });
    const beginExport = vi.fn().mockResolvedValue({ status: 'ok', sequence: 4, count: options.count ?? 2, studyIds: ['study-a'] });
    const readExportPage = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', interviews: [interview()], aggregates: [], explorations: [], nextCursor: 'next' })
      .mockResolvedValueOnce({ status: 'ok', interviews: [second], aggregates: [], explorations: [], nextCursor: null });
    const verifyExportSequence = vi.fn().mockResolvedValue(options.verify ?? 'unchanged');
    const durable = { ...store, backend: 'durable-object', beginExport, readExportPage, verifyExportSequence } as unknown as DurableWorkspaceStorePort;
    access.getAuthorizedResearcherStudyContext.mockResolvedValue({ authorized: true, context: { store: durable } });
    return { beginExport, readExportPage, verifyExportSequence, second };
  }

  it('streams the durable snapshot page by page with the same bytes as the Node file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(exportedAt);
    const { beginExport, readExportPage, verifyExportSequence, second } = durableStore();
    const response = await GET(request('studyId=study-a&format=markdown'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(beginExport).toHaveBeenCalledWith({ maximum: 500, studyId: 'study-a' });
    for (const [input] of readExportPage.mock.calls) expect(input.studyId).toBe('study-a');
    expect(verifyExportSequence).toHaveBeenCalledWith({ sequence: 4, studyId: 'study-a' });
    expect(text).toBe(buildTranscriptsMarkdown(study, [interview(), second], exportedAt));
  });

  it('never writes the closing marker when the snapshot changed during the download', async () => {
    durableStore({ verify: 'changed' });
    const response = await GET(request('studyId=study-a&format=markdown'));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('answers 404 when the durable study holds only analysis or notebook records', async () => {
    const { readExportPage } = durableStore({ count: 0 });
    expect((await GET(request('studyId=study-a&format=markdown'))).status).toBe(404);
    expect(readExportPage).not.toHaveBeenCalled();
  });
});

describe('checked transcript download', () => {
  it('offers only a file that ends with the closing marker', async () => {
    const complete = buildTranscriptsMarkdown(study, [interview()], exportedAt);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(complete, { headers: { 'Content-Disposition': transcriptsContentDisposition(study.config.name, study.id) } }))
      .mockResolvedValueOnce(new Response(complete.slice(0, 200)));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await exportStudyTranscriptsChecked('study-a');
    expect(fetchMock).toHaveBeenCalledWith('/api/interviews/export?studyId=study-a&format=markdown');
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') expect(ok.value.filename).toBe('働き方の調査-transcripts.md');
    expect((await exportStudyTranscriptsChecked('study-a')).status).toBe('unavailable');
  });
});
