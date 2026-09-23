// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { StoredAggregateSynthesis, StoredInterview } from '@/types';
import { makeStoredInterview } from '../fixtures/models';
import { createZipStream, crc32, ZIP32_LIMITS, ZipLimitError } from '@/lib/export/zipStream';
import {
  createInterviewExportStream,
  ExportSnapshotChangedError,
  type InterviewExportPage,
} from '@/lib/export/interviewExport';

const contextMock = vi.hoisted(() => ({ getRequestContext: vi.fn() }));
vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getAllInterviewsChecked: vi.fn(),
  getStudyAggregateChecked: vi.fn(),
}));
vi.mock('@/lib/kv', () => kvMock);

import { GET } from '@/app/api/interviews/export/route';

const EOCD = [0x50, 0x4b, 0x05, 0x06];

type Collected = { bytes: Uint8Array; error: unknown };

async function collect(readable: ReadableStream<Uint8Array>): Promise<Collected> {
  const reader = readable.getReader();
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
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
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

/** Deterministic incompressible bytes. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

async function entriesOf(bytes: Uint8Array): Promise<Array<{ name: string; dir: boolean; text: string | null }>> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries: Array<{ name: string; dir: boolean; text: string | null }> = [];
  for (const name of Object.keys(zip.files)) {
    const file = zip.files[name];
    entries.push({ name, dir: file.dir, text: file.dir ? null : await file.async('string') });
  }
  return entries;
}

function aggregateFor(studyId: string, interviewIds: string[], overrides: Partial<StoredAggregateSynthesis> = {}): StoredAggregateSynthesis {
  return {
    studyId,
    studyRevision: 2,
    interviewIds,
    interviewCount: interviewIds.length,
    aiProvider: 'openai',
    aiModel: 'gpt-fixture',
    commonThemes: [],
    divergentViews: [],
    keyFindings: ['Ünïcödé finding — 研究'],
    researchImplications: [],
    bottomLine: '=SUM(1,1) is not a formula here',
    generatedAt: 1_760_000_000_000,
    savedAt: 1_760_000_100_000,
    ...overrides,
  };
}

async function* pagesOf(pages: InterviewExportPage[]): AsyncGenerator<InterviewExportPage> {
  for (const page of pages) yield page;
}

describe('createZipStream (RT-09, ST-08)', () => {
  it('ST-08: produces an archive JSZip opens with matching entries, CRCs, UTF-8 names and a directory', async () => {
    const zip = createZipStream({ modifiedAt: new Date(Date.UTC(2026, 8, 23, 12, 34, 56)) });
    const collected = collect(zip.readable);
    const large = noise(700_000);
    await zip.addFile('plain.txt', 'hello');
    await zip.addFile('empty.json', '');
    await zip.addDirectory('données/');
    await zip.addFile('données/研究-ü.md', 'Ünïcödé — 研究 🙂');
    await zip.addFile('binary.bin', large);
    await zip.finish();
    const { bytes, error } = await collected;
    expect(error).toBeNull();
    expect(containsSignature(bytes, EOCD)).toBe(true);

    const loaded = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(loaded.files)).toEqual(['plain.txt', 'empty.json', 'données/', 'données/研究-ü.md', 'binary.bin']);
    expect(loaded.files['données/'].dir).toBe(true);
    expect(await loaded.file('plain.txt')!.async('string')).toBe('hello');
    expect(await loaded.file('empty.json')!.async('string')).toBe('');
    expect(await loaded.file('données/研究-ü.md')!.async('string')).toBe('Ünïcödé — 研究 🙂');
    expect(await loaded.file('binary.bin')!.async('uint8array')).toEqual(large);
    expect(loaded.files['plain.txt'].date.toISOString()).toBe('2026-09-23T12:34:56.000Z');
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('ST-08: an aborted stream errors and never emits a central directory', async () => {
    const zip = createZipStream();
    const collected = collect(zip.readable);
    await zip.addFile('first.json', '{"a":1}');
    await zip.abort(new Error('snapshot changed'));
    await expect(zip.addFile('second.json', '{}')).rejects.toThrow();
    await expect(zip.finish()).rejects.toThrow();
    const { bytes, error } = await collected;
    expect(error).toBeInstanceOf(Error);
    expect(containsSignature(bytes, EOCD)).toBe(false);
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow();
  });

  it('ST-08: abort while an entry is streaming leaves no central directory', async () => {
    const zip = createZipStream({ highWaterMarkBytes: 1024 });
    const reader = zip.readable.getReader();
    const pending = zip.addFile('big.bin', noise(2_000_000));
    const first = await reader.read();
    expect(first.done).toBe(false);
    await zip.abort(new Error('client went away'));
    await expect(pending).rejects.toThrow();
    const parts: Uint8Array[] = [first.value!];
    await expect((async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        parts.push(next.value);
      }
    })()).rejects.toThrow();
    for (const part of parts) expect(containsSignature(part, EOCD)).toBe(false);
  });

  it('RT-09: applies backpressure, so buffered output stays bounded while the consumer is idle', async () => {
    const zip = createZipStream({ highWaterMarkBytes: 16 * 1024 });
    let settled = false;
    const adding = zip.addFile('noise.bin', noise(4_000_000)).then(() => {
      settled = true;
    });
    for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    const collected = collect(zip.readable);
    await adding;
    await zip.finish();
    const { bytes, error } = await collected;
    expect(error).toBeNull();
    expect((await JSZip.loadAsync(bytes, { checkCRC32: true })).file('noise.bin')).not.toBeNull();
  });

  it('refuses ZIP64-sized archives instead of writing them (entries, entry size, archive size)', async () => {
    expect(ZIP32_LIMITS).toEqual({ maxEntries: 0xfffe, maxEntryBytes: 0xfffffffe, maxArchiveBytes: 0xfffffffe });

    const byEntries = createZipStream({ limits: { maxEntries: 2 } });
    const entriesOut = collect(byEntries.readable);
    await byEntries.addFile('a', 'a');
    await byEntries.addFile('b', 'b');
    await expect(byEntries.addFile('c', 'c')).rejects.toMatchObject({ limit: 'entries' });
    expect((await entriesOut).error).toBeInstanceOf(ZipLimitError);
    expect(containsSignature((await entriesOut).bytes, EOCD)).toBe(false);

    const bySize = createZipStream({ limits: { maxEntryBytes: 10 } });
    const sizeOut = collect(bySize.readable);
    await expect(bySize.addFile('large', 'x'.repeat(11))).rejects.toMatchObject({ limit: 'entry-size' });
    expect((await sizeOut).error).toBeInstanceOf(ZipLimitError);

    const byArchive = createZipStream({ limits: { maxArchiveBytes: 200 } });
    const archiveOut = collect(byArchive.readable);
    await expect(byArchive.addFile('noise.bin', noise(1000))).rejects.toMatchObject({ limit: 'archive-size' });
    expect(containsSignature((await archiveOut).bytes, EOCD)).toBe(false);
  });

  it('rejects duplicate and malformed entry names without finalizing', async () => {
    const zip = createZipStream();
    const out = collect(zip.readable);
    await zip.addFile('same.json', '{}');
    await expect(zip.addFile('same.json', '{}')).rejects.toThrow(TypeError);
    expect(containsSignature((await out).bytes, EOCD)).toBe(false);
    const other = createZipStream();
    void collect(other.readable);
    await expect(other.addFile('/absolute', 'x')).rejects.toThrow(TypeError);
  });
});

describe('createInterviewExportStream parity with the Node JSZip export (ST-08, RT-09)', () => {
  beforeEach(() => {
    contextMock.getRequestContext.mockResolvedValue({ authorized: true, context: { kvClient: {} } });
  });

  function fixtures(): { interviews: StoredInterview[]; aggregates: Map<string, StoredAggregateSynthesis> } {
    const base = Date.UTC(2026, 8, 20, 9, 0, 0);
    const interviews = [
      makeStoredInterview({
        id: 'interview-c-3',
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
            { theme: 'Bare', frequency: 1 },
          ],
          contradictions: [],
          keyInsights: ['Insight one'],
          bottomLine: '@bottom line',
        },
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: base + 3_950_000, studyRevision: 2, generation: 1 },
      }),
      makeStoredInterview({
        id: 'interview-b-2',
        studyId: 'study-a',
        studyName: 'Study A',
        createdAt: base + 2_000_000,
        completedAt: base + 2_000_000,
        analysis: { status: 'failed', attempts: 2, lastAttemptAt: base, failureKind: 'timeout', recoveryRequired: true, generation: 2 },
      }),
      makeStoredInterview({
        id: 'interview-a-1',
        studyId: 'study-b',
        studyName: 'Study B',
        createdAt: base + 1_000_000,
        completedAt: base + 1_500_000,
        transcript: [],
        behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
      }),
    ];
    const aggregates = new Map<string, StoredAggregateSynthesis>([
      ['study-b', aggregateFor('study-b', ['interview-c-3', 'interview-a-1'])],
      ['study-a', aggregateFor('study-a', ['interview-b-2'], { divergentViews: [{ topic: 't', viewA: 'a', viewB: 'b' }] })],
    ]);
    return { interviews, aggregates };
  }

  async function jszipReference(interviews: StoredInterview[], aggregates: Map<string, StoredAggregateSynthesis>) {
    kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: interviews });
    kvMock.getStudyAggregateChecked.mockImplementation(async (studyId: string) => {
      const aggregate = aggregates.get(studyId);
      return aggregate ? { status: 'found', aggregate } : { status: 'not-found' };
    });
    const response = await GET();
    expect(response.status).toBe(200);
    return entriesOf(new Uint8Array(await response.arrayBuffer()));
  }

  it('ST-08: streamed pages reproduce every JSZip entry name, order and content', async () => {
    const { interviews, aggregates } = fixtures();
    const reference = await jszipReference(interviews, aggregates);

    // Paged exactly as the Durable Object pages: interviews, then aggregates
    // in first-seen study order.
    const stream = createInterviewExportStream({
      pages: pagesOf([
        { interviews: interviews.slice(0, 2), aggregates: [] },
        { interviews: interviews.slice(2), aggregates: [] },
        { interviews: [], aggregates: [aggregates.get('study-b')!] },
        { interviews: [], aggregates: [aggregates.get('study-a')!] },
      ]),
      beforeFinish: async () => undefined,
    });
    const { bytes, error } = await collect(stream);
    expect(error).toBeNull();
    const streamed = await entriesOf(bytes);

    expect(streamed.map((entry) => entry.name)).toEqual(reference.map((entry) => entry.name));
    expect(streamed).toEqual(reference);
    expect(streamed.map((entry) => entry.name)).toContain('aggregates/');
    const csv = streamed.find((entry) => entry.name === 'summary.csv')!.text!;
    expect(csv).toContain(`"'+HYPERLINK(""x"") Ünïcödé study"`);
    expect(csv).toContain(`"'@bottom line"`);
  });

  it('ST-08: an export without aggregates matches JSZip too (no aggregates/ folder)', async () => {
    const { interviews } = fixtures();
    const reference = await jszipReference(interviews, new Map());
    const { bytes } = await collect(createInterviewExportStream({ pages: pagesOf([{ interviews, aggregates: [] }]) }));
    expect(await entriesOf(bytes)).toEqual(reference);
  });

  it('ST-08: a snapshot change mid-export fails the stream without a central directory', async () => {
    const { interviews } = fixtures();
    const onError = vi.fn();
    async function* changing(): AsyncGenerator<InterviewExportPage> {
      yield { interviews: interviews.slice(0, 1), aggregates: [] };
      throw new ExportSnapshotChangedError();
    }
    const { bytes, error } = await collect(createInterviewExportStream({ pages: changing(), onError }));
    expect(error).toBeInstanceOf(ExportSnapshotChangedError);
    expect(onError).toHaveBeenCalledWith(expect.any(ExportSnapshotChangedError));
    expect(containsSignature(bytes, EOCD)).toBe(false);
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow();
  });

  it('ST-08: a throwing onError observer still errors the archive instead of leaving it open', async () => {
    const { interviews } = fixtures();
    async function* changing(): AsyncGenerator<InterviewExportPage> {
      yield { interviews: interviews.slice(0, 1), aggregates: [] };
      throw new ExportSnapshotChangedError();
    }
    const onError = vi.fn(() => {
      throw new Error('observer failed');
    });
    const outcome = await Promise.race([
      collect(createInterviewExportStream({ pages: changing(), onError })),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
    ]);
    expect(outcome).not.toBe('pending');
    if (outcome === 'pending') return;
    expect(outcome.error).toBeInstanceOf(ExportSnapshotChangedError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(containsSignature(outcome.bytes, EOCD)).toBe(false);
  });

  it('ST-08: a failed final sequence check omits archive finalization', async () => {
    const { interviews } = fixtures();
    const { bytes, error } = await collect(createInterviewExportStream({
      pages: pagesOf([{ interviews, aggregates: [] }]),
      beforeFinish: async () => {
        throw new ExportSnapshotChangedError();
      },
    }));
    expect(error).toBeInstanceOf(ExportSnapshotChangedError);
    expect(containsSignature(bytes, EOCD)).toBe(false);
  });
});
