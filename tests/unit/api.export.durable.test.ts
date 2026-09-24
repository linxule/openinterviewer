// @vitest-environment node
//
// Researcher export on the Cloudflare target (RT-09, ST-08, gap F1) at the
// route boundary. The Node reference is the same route over the real Redis
// workspace store (mocked kv reads) building its archive with JSZip; the
// Cloudflare side is the same route over the real Durable Object client whose
// WorkspaceStore object is an in-memory fake paging exactly as
// cloudflare/workspace/exports.ts does (newest interview first, then each
// captured aggregate in first-seen study order).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { StoredAggregateSynthesis, StoredInterview } from '@/types';
import { makeStoredInterview } from '../fixtures/models';
import { standaloneTestContext } from '../helpers/workspaceStoreFixture';
import type { RedisPort } from '@/lib/redisPort';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn(), getHostedResearcherIdentity: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getAllInterviewsChecked: vi.fn(),
  getStudyAggregateChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

// Pass-through: records what the route hands the stream builder and lets a
// test shrink the archive budget without building a 32 MiB fixture.
const exportStreamSpy = vi.hoisted(() => ({
  inputs: [] as Array<{ limits?: Record<string, number> }>,
  limitsOverride: null as Record<string, number> | null,
}));
vi.mock('@/lib/export/interviewExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/interviewExport')>();
  return {
    ...actual,
    createInterviewExportStream: (input: Parameters<typeof actual.createInterviewExportStream>[0]) => {
      exportStreamSpy.inputs.push(input as { limits?: Record<string, number> });
      const override = exportStreamSpy.limitsOverride;
      return actual.createInterviewExportStream(override ? { ...input, limits: { ...input.limits, ...override } } : input);
    },
  };
});

import { GET } from '@/app/api/interviews/export/route';
import { ZipLimitError } from '@/lib/export/zipStream';
import { createDurableWorkspaceStore } from '@/lib/storage/durableObject';
import {
  exportAllInterviews,
  exportAllInterviewsChecked,
  isCompleteZipArchive,
  ResearcherStorageUnavailableError,
} from '@/services/storageService';

const WORKSPACE_ID = 'ws_0123456789abcdef0123456789abcdef';
const SEQUENCE = 41;
const EOCD = [0x50, 0x4b, 0x05, 0x06];

type RpcCall = { method: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;

let rpcCalls: RpcCall[] = [];
let handlers: Record<string, Handler> = {};

const workspaceStub = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== 'string' || property === 'then') return undefined;
    return async (input: Record<string, unknown>) => {
      rpcCalls.push({ method: property, input });
      const handler = handlers[property];
      if (!handler) throw new Error(`unscripted RPC ${property}`);
      return handler(input);
    };
  },
});

function durableContext() {
  const store = createDurableWorkspaceStore({
    namespace: { getByName: () => workspaceStub },
    workspaceId: WORKSPACE_ID,
    jurisdiction: '',
    rateLimitSalt: 'synthetic-rate-limit-salt-0123456789abcdef',
  });
  return standaloneTestContext({} as RedisPort, { store });
}

function aggregateFor(studyId: string, interviewIds: string[], overrides: Partial<StoredAggregateSynthesis> = {}): StoredAggregateSynthesis {
  return {
    studyId,
    studyRevision: 2,
    interviewIds,
    interviewCount: interviewIds.length,
    aiProvider: 'openai',
    aiModel: 'gpt-fixture',
    commonThemes: [{ theme: 'Trust', frequency: 2, representativeQuotes: ['Ünïcödé quote — 研究'] }],
    divergentViews: [],
    keyFindings: ['Ünïcödé finding — 研究'],
    researchImplications: [],
    bottomLine: '=SUM(1,1) is not a formula here',
    generatedAt: 1_760_000_000_000,
    savedAt: 1_760_000_100_000,
    ...overrides,
  };
}

/** Newest first, as both the Redis collection and the object's snapshot order them. */
function fixtures(): { interviews: StoredInterview[]; aggregates: StoredAggregateSynthesis[] } {
  const base = Date.UTC(2026, 8, 20, 9, 0, 0);
  const interviews = [
    makeStoredInterview({
      id: 'session-cc33-newest',
      studyId: 'study-b',
      studyName: '+HYPERLINK("x") Ünïcödé study',
      createdAt: base + 3_000_000,
      completedAt: base + 3_900_000,
      participantProfile: {
        id: 'p-3',
        fields: [
          { fieldId: 'role', value: 'Nurse — 研究', status: 'extracted' },
          { fieldId: 'team', value: null, status: 'refused' },
        ],
        rawContext: 'Works nights',
        timestamp: base,
      },
      transcript: [
        { id: 'm-1', role: 'ai', content: 'Hello 👋', timestamp: base + 3_000_000 },
        { id: 'm-2', role: 'user', content: '=cmd|calc', timestamp: base + 3_060_000 },
      ],
      synthesis: {
        statedPreferences: [],
        revealedPreferences: [],
        themes: [
          { theme: 'Trust', frequency: 1, evidence: 'quoted' },
          { theme: 'Time', frequency: 1, evidenceRefs: [{ quote: 'no time', turnIndex: 2 }] },
        ],
        contradictions: [],
        keyInsights: ['Insight one'],
        bottomLine: '@bottom line',
      },
      analysis: { status: 'complete', attempts: 1, lastAttemptAt: base + 3_950_000, studyRevision: 2, generation: 1 },
    }),
    makeStoredInterview({
      id: 'session-bb22-middle',
      studyId: 'study-a',
      studyName: 'Study A',
      createdAt: base + 2_000_000,
      completedAt: base + 2_000_000,
      analysis: { status: 'pending', attempts: 0, lastAttemptAt: base + 2_000_000, generation: 1 },
    }),
    makeStoredInterview({
      id: 'session-aa11-oldest',
      studyId: 'study-b',
      studyName: 'Study B',
      createdAt: base + 1_000_000,
      completedAt: base + 1_500_000,
      transcript: [],
      analysis: { status: 'failed', attempts: 2, lastAttemptAt: base, failureKind: 'timeout', recoveryRequired: true, generation: 2 },
    }),
    makeStoredInterview({
      id: 'session-dd44-no-aggregate',
      studyId: 'study-c',
      studyName: 'Study C',
      createdAt: base + 500_000,
      completedAt: base + 600_000,
    }),
  ];
  // First-seen study order in export order: study-b, study-a (study-c has none).
  const aggregates = [
    aggregateFor('study-b', ['session-cc33-newest', 'session-aa11-oldest']),
    aggregateFor('study-a', ['session-bb22-middle'], { divergentViews: [{ topic: 't', viewA: 'a', viewB: 'b' }] }),
  ];
  return { interviews, aggregates };
}

/**
 * The object's export RPCs over captured fixtures. One row per page, so the
 * route walks several pages; `pageHook` may replace a reply by cursor.
 */
function scriptExport(
  data: { interviews: StoredInterview[]; aggregates: StoredAggregateSynthesis[] },
  options: { pageHook?: (cursor: string | null) => unknown; verify?: string } = {},
): void {
  handlers.beginExport = () => ({
    status: 'ok',
    sequence: SEQUENCE,
    count: data.interviews.length,
    studyIds: data.aggregates.map((aggregate) => aggregate.studyId),
  });
  handlers.readExportPage = (input) => {
    const cursor = input.cursor as string | null;
    const hooked = options.pageHook?.(cursor);
    if (hooked) return hooked;
    const afterInterviews = data.aggregates.length > 0 ? JSON.stringify(['a', 0]) : null;
    const parsed = cursor === null ? null : JSON.parse(cursor) as [string, number | string, string?];
    if (parsed === null || parsed[0] === 'i') {
      const start = parsed === null ? 0 : data.interviews.findIndex((row) => row.id === parsed[2]) + 1;
      const row = data.interviews[start];
      const next = start + 1 < data.interviews.length ? JSON.stringify(['i', row.createdAt, row.id]) : afterInterviews;
      return { status: 'ok', interviews: [row], aggregates: [], nextCursor: next };
    }
    const position = parsed[1] as number;
    return {
      status: 'ok',
      interviews: [],
      aggregates: [data.aggregates[position]],
      nextCursor: position + 1 < data.aggregates.length ? JSON.stringify(['a', position + 1]) : null,
    };
  };
  handlers.verifyExportSequence = () => ({ status: options.verify ?? 'unchanged' });
}

type Entry = { name: string; dir: boolean; text: string | null };

async function entriesOf(bytes: Uint8Array | ArrayBuffer): Promise<Entry[]> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries: Entry[] = [];
  for (const name of Object.keys(zip.files)) {
    const file = zip.files[name];
    entries.push({ name, dir: file.dir, text: file.dir ? null : await file.async('string') });
  }
  return entries;
}

async function collect(response: Response): Promise<{ bytes: Uint8Array; error: unknown }> {
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let error: unknown = null;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
  } catch (caught) {
    error = caught;
  }
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, error };
}

function containsSignature(bytes: Uint8Array, signature: number[]): boolean {
  outer: for (let index = 0; index + signature.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < signature.length; offset += 1) {
      if (bytes[index + offset] !== signature[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * The delivery observed in local workerd (wrangler dev 4.136.3) through the
 * OpenNext cloudflare-node adapter: a route body that errors after the
 * headers reaches the client as a clean 200 ending with the bytes written so
 * far, so fetch().blob() resolves instead of rejecting.
 */
function cleanCloseOnError(response: Response): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch {
        controller.close();
      }
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

const INCOMPLETE_EXPORT = {
  status: 'unavailable',
  error: 'The export did not complete. Try the export again.',
  retryable: true,
} as const;

const methods = () => rpcCalls.map((call) => call.method);

beforeEach(() => {
  rpcCalls = [];
  handlers = {};
  exportStreamSpy.inputs = [];
  exportStreamSpy.limitsOverride = null;
  contextMock.getRequestContext.mockResolvedValue({ authorized: true, context: durableContext() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/interviews/export on Cloudflare (RT-09, ST-08, F1)', () => {
  it('ST-08: the streamed archive reproduces every Node JSZip entry name, order and content', async () => {
    const data = fixtures();

    // Node reference: the same route over the Redis workspace store.
    contextMock.getRequestContext.mockResolvedValueOnce({ authorized: true, context: standaloneTestContext({} as RedisPort) });
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: data.interviews });
    kvMock.getStudyAggregateChecked.mockImplementation(async (studyId: string) => {
      const aggregate = data.aggregates.find((candidate) => candidate.studyId === studyId);
      return aggregate ? { status: 'found', aggregate } : { status: 'not-found' };
    });
    const node = await GET();
    expect(node.status).toBe(200);
    const reference = await entriesOf(await node.arrayBuffer());
    expect(kvMock.getAllInterviewsChecked).toHaveBeenCalledWith({}, 500);

    scriptExport(data);
    const streamed = await GET();

    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe(node.headers.get('content-type'));
    expect(streamed.headers.get('content-disposition')).toMatch(/^attachment; filename=interviews-export-\d+\.zip$/);
    expect(streamed.headers.get('cache-control')).toBe('no-store');
    const { bytes, error } = await collect(streamed);
    expect(error).toBeNull();
    const entries = await entriesOf(bytes);

    expect(entries.map((entry) => entry.name)).toEqual(reference.map((entry) => entry.name));
    expect(entries).toEqual(reference);
    expect(entries.map((entry) => entry.name)).toEqual([
      '001_2026-09-20_session-.json', '001_2026-09-20_session-.md',
      '002_2026-09-20_session-.json', '002_2026-09-20_session-.md',
      '003_2026-09-20_session-.json', '003_2026-09-20_session-.md',
      '004_2026-09-20_session-.json', '004_2026-09-20_session-.md',
      'aggregates/', 'aggregates/study-b.json', 'aggregates/study-a.json', 'summary.csv',
    ]);
    const csv = entries.find((entry) => entry.name === 'summary.csv')!.text!;
    expect(csv).toContain(`"'+HYPERLINK(""x"") Ünïcödé study"`);
    expect(csv).toContain(`"'@bottom line"`);

    // One snapshot: every page and the final check carry the captured
    // sequence, within the object's page bounds; finalization is verified once.
    expect(methods().filter((method) => method === 'beginExport')).toHaveLength(1);
    expect(rpcCalls[0].input).toEqual({ maximum: 500 });
    const pages = rpcCalls.filter((call) => call.method === 'readExportPage');
    expect(pages).toHaveLength(data.interviews.length + data.aggregates.length);
    for (const page of pages) {
      expect(page.input.sequence).toBe(SEQUENCE);
      expect(page.input.pageSize).toBeLessThanOrEqual(200);
      expect(page.input.maxPageBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
    expect(methods().at(-1)).toBe('verifyExportSequence');
    expect(rpcCalls.at(-1)!.input).toEqual({ sequence: SEQUENCE });
  });

  it.each<[string, unknown, number, Record<string, unknown>]>([
    ['an empty workspace', { status: 'empty' }, 404, { error: 'No interviews to export' }],
    ['more than 500 interviews', { status: 'too-large', count: 501, maximum: 500 }, 413,
      { error: 'This export is too large for an interactive download. Export a smaller study set.' }],
    ['unavailable storage', { status: 'unavailable' }, 503, { error: 'Interview storage is temporarily unavailable.', retryable: true }],
  ])('ST-08: %s keeps the Node response (%#)', async (_label, begun, status, body) => {
    handlers.beginExport = () => begun;

    const response = await GET();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(methods()).toEqual(['beginExport']);
  });

  it('F1/ST-08: a snapshot change before the response starts is 409 EXPORT_CHANGED, retryable', async () => {
    scriptExport(fixtures(), { pageHook: (cursor) => (cursor === null ? { status: 'changed' } : null) });

    const response = await GET();

    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: 'EXPORT_CHANGED', retryable: true });
    expect(methods()).toEqual(['beginExport', 'readExportPage']);
  });

  it('ST-08: an unreadable first page is 503 before any archive byte', async () => {
    scriptExport(fixtures(), { pageHook: (cursor) => (cursor === null ? { status: 'unavailable' } : null) });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Interview storage is temporarily unavailable.', retryable: true });
  });

  it.each<[string, { pageHook?: (cursor: string | null) => unknown; verify?: string }]>([
    ['a later page reports the snapshot changed', { pageHook: (cursor) => (cursor !== null ? { status: 'changed' } : null) }],
    ['a later page is unavailable', { pageHook: (cursor) => (cursor?.startsWith('["a"') ? { status: 'unavailable' } : null) }],
    ['a page makes no progress', {
      pageHook: (cursor) => (cursor !== null
        ? { status: 'ok', interviews: [], aggregates: [], nextCursor: cursor }
        : null),
    }],
    ['the final sequence check reports a change', { verify: 'changed' }],
    ['the final sequence check is unavailable', { verify: 'unavailable' }],
  ])('ST-08: after the headers, %s errors the stream and never finalizes the archive', async (_label, options) => {
    scriptExport(fixtures(), options);

    const response = await GET();
    expect(response.status).toBe(200);
    const { bytes, error } = await collect(response);

    expect(error).not.toBeNull();
    expect(containsSignature(bytes, EOCD)).toBe(false);
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow();
  });

  it('ST-08: a ZIP limit reached mid-stream errors the stream and is logged as too-large; the route sets no byte cap of its own', async () => {
    scriptExport(fixtures());
    exportStreamSpy.limitsOverride = { maxArchiveBytes: 512 };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await GET();
    expect(response.status).toBe(200);
    const { bytes, error } = await collect(response);

    // Response backpressure (cloudflare/opennext/backpressureWrapper.ts)
    // bounds memory, so only the ZIP32 structural limits apply.
    expect(exportStreamSpy.inputs).toHaveLength(1);
    expect(exportStreamSpy.inputs[0].limits).toBeUndefined();
    expect(error).toBeInstanceOf(ZipLimitError);
    expect(bytes.length).toBeLessThanOrEqual(512);
    expect(containsSignature(bytes, EOCD)).toBe(false);
    expect(methods()).not.toContain('verifyExportSequence');
    // The failure is logged once the writer has finished aborting.
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    const events = logged.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({
      event: 'route.failure',
      route: '/api/interviews/export',
      reason: 'too-large',
      errorType: 'ZipLimitError',
    })]);
  });
});

describe('researcher export client (ST-08)', () => {
  it('ST-08: an archive stream that errors after the headers is a failure, never a partial download', async () => {
    scriptExport(fixtures(), { verify: 'changed' });
    const response = await GET();
    expect(response.status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(exportAllInterviewsChecked()).resolves.toEqual({
      status: 'unavailable',
      error: 'Interview export is temporarily unavailable.',
      retryable: true,
    });
  });

  it('F1: 409 EXPORT_CHANGED is reported as a retryable failure with the server message', async () => {
    scriptExport(fixtures(), { pageHook: (cursor) => (cursor === null ? { status: 'changed' } : null) });
    const response = await GET();
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(exportAllInterviewsChecked()).resolves.toEqual({
      status: 'unavailable',
      error: 'The interviews changed while the export was being prepared. Try the export again.',
      retryable: true,
    });
  });

  it('ST-08: a complete streamed archive is returned whole', async () => {
    scriptExport(fixtures());
    const response = await GET();
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const outcome = await exportAllInterviewsChecked();
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const entries = await entriesOf(await outcome.value.arrayBuffer());
    expect(entries.map((entry) => entry.name)).toContain('summary.csv');
  });

  it.each<[string, { pageHook?: (cursor: string | null) => unknown; verify?: string }]>([
    ['the final sequence check reports a change', { verify: 'changed' }],
    ['a later page reports the snapshot changed', { pageHook: (cursor) => (cursor !== null ? { status: 'changed' } : null) }],
    ['a later page is unavailable', { pageHook: (cursor) => (cursor?.startsWith('["a"') ? { status: 'unavailable' } : null) }],
  ])('F1/ST-08: when %s after the headers and the platform ends the body cleanly, the partial archive is refused', async (_label, options) => {
    scriptExport(fixtures(), options);
    const routed = await GET();
    expect(routed.status).toBe(200);
    const delivered = cleanCloseOnError(routed);
    vi.stubGlobal('fetch', vi.fn(async () => delivered));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(exportAllInterviewsChecked()).resolves.toEqual(INCOMPLETE_EXPORT);
  });

  it('F1/ST-08: the Dashboard entry point raises the retryable failure instead of returning the truncated blob', async () => {
    scriptExport(fixtures(), { verify: 'changed' });
    const delivered = cleanCloseOnError(await GET());
    vi.stubGlobal('fetch', vi.fn(async () => delivered));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failure = await exportAllInterviews().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResearcherStorageUnavailableError);
    expect((failure as Error).message).toBe(INCOMPLETE_EXPORT.error);
  });

  it('ST-08: the Node JSZip archive passes the same completeness check (Node and hosted downloads unchanged)', async () => {
    const data = fixtures();
    contextMock.getRequestContext.mockResolvedValueOnce({ authorized: true, context: standaloneTestContext({} as RedisPort) });
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: data.interviews });
    kvMock.getStudyAggregateChecked.mockImplementation(async (studyId: string) => {
      const aggregate = data.aggregates.find((candidate) => candidate.studyId === studyId);
      return aggregate ? { status: 'found', aggregate } : { status: 'not-found' };
    });
    const node = await GET();
    vi.stubGlobal('fetch', vi.fn(async () => node));

    const outcome = await exportAllInterviewsChecked();

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect((await entriesOf(await outcome.value.arrayBuffer())).map((entry) => entry.name)).toContain('aggregates/study-a.json');
  });

  it('F1: no strict prefix of a complete archive, from either writer, passes the completeness check', async () => {
    const data = fixtures();
    scriptExport(data);
    const streamed = (await collect(await GET())).bytes;
    contextMock.getRequestContext.mockResolvedValueOnce({ authorized: true, context: standaloneTestContext({} as RedisPort) });
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: data.interviews });
    kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'not-found' });
    const jszip = new Uint8Array(await (await GET()).arrayBuffer());

    for (const archive of [streamed, jszip] as Uint8Array<ArrayBuffer>[]) {
      expect(await isCompleteZipArchive(new Blob([archive]))).toBe(true);
      for (let length = 0; length < archive.length; length += 1) {
        if (await isCompleteZipArchive(new Blob([archive.subarray(0, length)]))) {
          throw new Error(`a ${length}-byte prefix of a ${archive.length}-byte archive passed`);
        }
      }
      // Anything after the closing record is not an archive either writer produced.
      expect(await isCompleteZipArchive(new Blob([archive, new Uint8Array([0])]))).toBe(false);
    }
  });
});
