// Snapshot-fenced researcher export paging in the real WorkspaceStore (ST-08,
// RT-09; gap decision F1): the export reproduces the state captured at its
// start, is not invalidated by collection or analysis progress, and fails
// when a captured interview is deleted or a captured aggregate replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import JSZip from 'jszip';
import type { StoredAggregateSynthesis, StoredInterview, StoredStudy } from '../../src/types';
import { createInterviewExportStream, ExportSnapshotChangedError, type InterviewExportPage } from '../../src/lib/export/interviewExport';
import {
  EXPORT_MAX_INTERVIEWS,
  EXPORT_SNAPSHOT_LIMIT,
  EXPORT_SNAPSHOT_PREFIX,
  EXPORT_SNAPSHOT_TTL_MS,
} from '../../cloudflare/workspace/exports';
import { ANALYSIS_ATTACH_MARGIN_MS, QUEUED_SYNTHESIS_DEADLINE_MS } from '../../src/lib/storage/analysisProtocol';
import { testEnv, workspaceStub } from './helpers';
import {
  createStudy,
  DAY,
  enrolParticipant,
  HOUR,
  interviewRecord,
  mutationSeq,
  persistInput,
  sampleInterview,
  sampleStudy,
  T0,
} from './fixtures';
import { SYNTHESIS } from './jobFixtures';

const BASE = Date.UTC(2026, 8, 20, 9, 0, 0);

type Sql = SqlStorage;

async function withSql<T>(run: (sql: Sql) => T): Promise<T> {
  return runInDurableObject(workspaceStub(), (_instance, state) => run(state.storage.sql));
}

function config(id: string) {
  return { id, name: `Study ${id}`, description: '', researchQuestion: '', coreQuestions: [], topicAreas: [], profileSchema: [], aiBehavior: 'standard', aiProvider: 'openai', aiModel: 'gpt-fixture', consentText: '', createdAt: BASE };
}

function insertStudy(sql: Sql, id: string): void {
  sql.exec(
    `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
     VALUES (?, ?, 1, ?, ?, 0, 0, 0)`,
    id, JSON.stringify(config(id)), BASE, BASE,
  );
}

function record(id: string, studyId: string, createdAt: number, content = 'Hello'): StoredInterview {
  return {
    id,
    studyId,
    studyName: `Study ${studyId} — Ünïcödé`,
    participantProfile: { id: `p-${id}`, fields: [], rawContext: '', timestamp: createdAt },
    transcript: [{ id: 'm-1', role: 'user', content, timestamp: createdAt }],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt,
    completedAt: createdAt + 60_000,
    status: 'completed',
  };
}

function insertInterview(sql: Sql, interview: StoredInterview, analysis?: { status: 'pending' | 'complete'; synthesisJson?: string }): void {
  sql.exec(
    `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, participant_session_id, link_id, sample_fixture, study_revision)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1)`,
    interview.id, interview.studyId, JSON.stringify(interview), 'f'.repeat(64), interview.createdAt, interview.completedAt,
  );
  if (!analysis) return;
  const complete = analysis.status === 'complete';
  sql.exec(
    `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, failure_kind, recovery_required,
       study_revision, synthesis_json, provenance_json, updated_at)
     VALUES (?, ?, 1, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    interview.id, analysis.status, complete ? 1 : 0, interview.createdAt, complete ? 1 : null,
    complete ? analysis.synthesisJson ?? JSON.stringify({ statedPreferences: [], revealedPreferences: [], themes: [], contradictions: [], keyInsights: [], bottomLine: 'done' }) : null,
    complete ? JSON.stringify({ aiProvider: 'openai', aiModel: 'gpt-fixture-2026', requestedAiModel: 'gpt-fixture' }) : null,
    interview.createdAt,
  );
}

function aggregate(studyId: string, interviewIds: string[]): StoredAggregateSynthesis {
  return {
    studyId, studyRevision: 1, interviewIds, interviewCount: interviewIds.length, aiProvider: 'openai', aiModel: 'gpt-fixture',
    commonThemes: [], divergentViews: [], keyFindings: ['研究'], researchImplications: [], bottomLine: 'aggregate', generatedAt: BASE, savedAt: BASE,
  };
}

function insertAggregate(sql: Sql, studyId: string, json: string): void {
  sql.exec(`INSERT INTO aggregates (study_id, aggregate_json, saved_at) VALUES (?, ?, ?)`, studyId, json, BASE);
}

function bump(sql: Sql): void {
  sql.exec(`UPDATE workspace_meta SET mutation_seq = mutation_seq + 1 WHERE singleton = 1`);
}

beforeEach(async () => {
  await reset();
  vi.spyOn(testEnv.ANALYSIS_QUEUE, 'send').mockImplementation(async () => ({ metadata: {} }) as QueueSendResponse);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('network is not available to export tests');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PROVENANCE = { aiProvider: 'openai' as const, aiModel: 'gpt-5.6-terra-2026-09-01', requestedAiModel: 'gpt-5.6-terra' };

type Saved = { study: StoredStudy; interviewId: string; jobId: string };

/** A participant completion through the real persistCompletedInterview RPC (interview, analysis row, generation 1). */
async function completeInterview(study: StoredStudy, createdAt: number): Promise<Saved> {
  const participant = await enrolParticipant(study);
  const jobId = crypto.randomUUID();
  const interview = interviewRecord(participant, { createdAt, completedAt: createdAt + 60_000 });
  expect(await workspaceStub().persistCompletedInterview(await persistInput(participant, { interview, jobId }))).toEqual({ status: 'created' });
  return { study, interviewId: interview.id, jobId };
}

function fence(saved: Saved) {
  return { workspaceId: testEnv.WORKSPACE_ID, interviewId: saved.interviewId, jobId: saved.jobId, generation: 1, recoveryEpoch: testEnv.ANALYSIS_RECOVERY_EPOCH };
}

/** The Queue consumer's claim → start → attach sequence through the real job RPCs. */
async function analyze(saved: Saved): Promise<void> {
  const stub = workspaceStub();
  const claimNonce = crypto.randomUUID();
  expect(await stub.claimAnalysisJob({ ...fence(saved), claimNonce, now: Date.now() })).toMatchObject({ status: 'claimed' });
  expect(await stub.markAnalysisStarted({
    ...fence(saved), claimNonce, requiredRemainingMs: QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS, now: Date.now(),
  })).toMatchObject({ status: 'started' });
  expect(await stub.finishAnalysisJob({
    ...fence(saved), claimNonce, now: Date.now(), outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance: PROVENANCE },
  })).toEqual({ status: 'written', replayed: false });
}

async function snapshotKeys(): Promise<string[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) =>
    [...state.storage.kv.list({ prefix: EXPORT_SNAPSHOT_PREFIX })].map(([key]) => key));
}

type Page = Extract<Awaited<ReturnType<ReturnType<typeof workspaceStub>['readExportPage']>>, { status: 'ok' }>;

async function readAll(sequence: number, pageSize: number, maxPageBytes: number, from: string | null = null): Promise<Page[]> {
  const stub = workspaceStub();
  const pages: Page[] = [];
  let cursor: string | null = from;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await stub.readExportPage({ sequence, cursor, pageSize, maxPageBytes });
    if (page.status !== 'ok') throw new Error(`page ${page.status}`);
    pages.push(page as Page);
    cursor = page.nextCursor;
    if (cursor === null) return pages;
  }
  throw new Error('export did not terminate');
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe('researcher export paging (ST-08, RT-09)', () => {
  it('ST-08: beginExport reports empty, too-large and the captured mutation sequence', async () => {
    const stub = workspaceStub();
    expect(await stub.beginExport({ maximum: 500 })).toEqual({ status: 'empty' });
    await withSql((sql) => {
      insertStudy(sql, 'study-a');
      insertStudy(sql, 'study-b');
      insertStudy(sql, 'study-c');
      insertInterview(sql, record('iv-1', 'study-a', BASE + 1_000));
      insertInterview(sql, record('iv-2', 'study-b', BASE + 2_000));
      insertInterview(sql, record('iv-3', 'study-c', BASE + 3_000));
      insertAggregate(sql, 'study-a', JSON.stringify(aggregate('study-a', ['iv-1'])));
      insertAggregate(sql, 'study-b', JSON.stringify(aggregate('study-b', ['iv-2'])));
      // Malformed stored aggregate: absent, as the Redis reader treats it.
      insertAggregate(sql, 'study-c', '{"studyId":"study-c"}');
      bump(sql);
    });
    expect(await stub.beginExport({ maximum: 2 })).toEqual({ status: 'too-large', count: 3, maximum: 2 });
    const sequence = await withSql((sql) => sql.exec<{ s: number }>(`SELECT mutation_seq AS s FROM workspace_meta`).one().s);
    // First-seen order over newest-first interviews: study-b (iv-2) before study-a (iv-1).
    expect(await stub.beginExport({ maximum: 500 })).toEqual({ status: 'ok', sequence, count: 3, studyIds: ['study-b', 'study-a'] });
  });

  it('ST-08/RT-09: pages newest first by (created_at, id), then aggregates in first-seen order, into a JSZip-readable archive', async () => {
    await withSql((sql) => {
      insertStudy(sql, 'study-a');
      insertStudy(sql, 'study-b');
      // Two interviews share created_at: the id breaks the tie, descending.
      insertInterview(sql, record('iv-a1', 'study-a', BASE + 1_000), { status: 'complete' });
      insertInterview(sql, record('iv-b1', 'study-b', BASE + 2_000), { status: 'pending' });
      insertInterview(sql, record('iv-b2', 'study-b', BASE + 3_000, '=cmd|calc — 研究'));
      insertInterview(sql, record('iv-a2', 'study-a', BASE + 3_000));
      insertAggregate(sql, 'study-a', JSON.stringify(aggregate('study-a', ['iv-a1', 'iv-a2'])));
      insertAggregate(sql, 'study-b', JSON.stringify(aggregate('study-b', ['iv-b1'])));
      bump(sql);
    });
    const stub = workspaceStub();
    const begun = await stub.beginExport({ maximum: 500 });
    expect(begun).toMatchObject({ status: 'ok', count: 4, studyIds: ['study-b', 'study-a'] });
    if (begun.status !== 'ok') return;
    const pages = await readAll(begun.sequence, 3, 1024 * 1024);
    expect(pages.map((page) => page.interviews.map((interview) => interview.id))).toEqual([
      ['iv-b2', 'iv-a2', 'iv-b1'],
      ['iv-a1'],
      [],
    ]);
    expect(pages.map((page) => page.aggregates.map((item) => item.studyId))).toEqual([[], [], ['study-b', 'study-a']]);

    const complete = pages[1].interviews[0];
    expect(complete.analysis).toEqual({ status: 'complete', attempts: 1, lastAttemptAt: BASE + 1_000, generation: 1, studyRevision: 1 });
    expect(complete.aiModel).toBe('gpt-fixture-2026');
    expect(JSON.stringify(pages)).not.toMatch(/claim|epoch|record_json|mutation_seq/);
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'unchanged' });

    // The same pages compose the streamed archive in workerd.
    async function* source(): AsyncGenerator<InterviewExportPage> {
      for (const page of pages) yield { interviews: page.interviews, aggregates: page.aggregates };
    }
    const archive = new Uint8Array(await new Response(createInterviewExportStream({
      pages: source(),
      beforeFinish: async () => {
        const verified = await stub.verifyExportSequence({ sequence: begun.sequence });
        if (verified.status !== 'unchanged') throw new ExportSnapshotChangedError();
      },
    })).arrayBuffer());
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual([
      '001_2026-09-20_iv-b2.json', '001_2026-09-20_iv-b2.md',
      '002_2026-09-20_iv-a2.json', '002_2026-09-20_iv-a2.md',
      '003_2026-09-20_iv-b1.json', '003_2026-09-20_iv-b1.md',
      '004_2026-09-20_iv-a1.json', '004_2026-09-20_iv-a1.md',
      'aggregates/', 'aggregates/study-b.json', 'aggregates/study-a.json', 'summary.csv',
    ]);
    expect(JSON.parse(await zip.file('004_2026-09-20_iv-a1.json')!.async('string'))).toEqual(complete);
    const csv = await zip.file('summary.csv')!.async('string');
    expect(csv.split('\n')).toHaveLength(5);
    expect(csv).toContain('"complete"');
  });

  it('ST-08: honours pageSize and maxPageBytes (measured) and still progresses past an oversized record', async () => {
    const body = 'x'.repeat(300_000);
    await withSql((sql) => {
      insertStudy(sql, 'study-big');
      for (let index = 0; index < 6; index += 1) {
        insertInterview(sql, record(`big-${index}`, 'study-big', BASE + index * 1_000, body), { status: 'complete' });
      }
      insertInterview(sql, record('huge', 'study-big', BASE + 10_000, 'y'.repeat(1_500_000)));
      bump(sql);
    });
    const stub = workspaceStub();
    const begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const maxPageBytes = 1_000_000;
    const pages = await readAll(begun.sequence, 50, maxPageBytes);
    const interviewPages = pages.filter((page) => page.interviews.length > 0);
    expect(interviewPages[0].interviews.map((interview) => interview.id)).toEqual(['huge']);
    for (const page of interviewPages.slice(1)) {
      expect(page.interviews.length).toBeGreaterThan(0);
      expect(jsonBytes(page.interviews)).toBeLessThanOrEqual(maxPageBytes);
    }
    expect(interviewPages.flatMap((page) => page.interviews.map((interview) => interview.id))).toEqual([
      'huge', 'big-5', 'big-4', 'big-3', 'big-2', 'big-1', 'big-0',
    ]);
    const bySize = await readAll(begun.sequence, 2, 16 * 1024 * 1024);
    expect(bySize.filter((page) => page.interviews.length > 0).map((page) => page.interviews.length)).toEqual([2, 2, 2, 1]);
  });

  it('ST-08/F1: completions, claims, starts and attaches through the real RPCs between pages neither invalidate the export nor reach it', async () => {
    const stub = workspaceStub();
    const study = await createStudy();
    const oldest = await completeInterview(study, T0 - 3 * HOUR);
    const middle = await completeInterview(study, T0 - 2 * HOUR);
    const newest = await completeInterview(study, T0 - HOUR);
    const begun = await stub.beginExport({ maximum: 500 });
    expect(begun).toMatchObject({ status: 'ok', count: 3, studyIds: [] });
    if (begun.status !== 'ok') return;
    const first = await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 1, maxPageBytes: 1_000_000 });
    expect(first).toMatchObject({ status: 'ok', interviews: [{ id: newest.interviewId }] });
    if (first.status !== 'ok') return;

    // Collection and analysis continue: a new completion, a full attach on a
    // captured row, and a claim on another. Each advances the sequence.
    const before = await mutationSeq();
    const late = await completeInterview(study, T0);
    await analyze(oldest);
    expect(await stub.claimAnalysisJob({ ...fence(middle), claimNonce: crypto.randomUUID(), now: Date.now() })).toMatchObject({ status: 'claimed' });
    expect(await mutationSeq()).toBeGreaterThanOrEqual(before + 4);

    const rest = await readAll(begun.sequence, 1, 1_000_000, first.nextCursor);
    const exported = [...first.interviews, ...rest.flatMap((page) => page.interviews)];
    expect(exported.map((interview) => interview.id)).toEqual([newest.interviewId, middle.interviewId, oldest.interviewId]);
    expect(exported.map((interview) => interview.id)).not.toContain(late.interviewId);
    // The captured analysis state, not the later one.
    for (const interview of exported) {
      expect(interview.analysis).toMatchObject({ status: 'pending', attempts: 0, generation: 1 });
      expect(interview.synthesis).toBeNull();
    }
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'unchanged' });

    // A new export captures the new state.
    const again = await stub.beginExport({ maximum: 500 });
    if (again.status !== 'ok') throw new Error(again.status);
    const current = (await readAll(again.sequence, 10, 1_000_000)).flatMap((page) => page.interviews);
    expect(current.map((interview) => interview.id)).toEqual([late.interviewId, newest.interviewId, middle.interviewId, oldest.interviewId]);
    expect(current.find((interview) => interview.id === oldest.interviewId)).toMatchObject({
      synthesis: SYNTHESIS, aiModel: PROVENANCE.aiModel, analysis: { status: 'complete', attempts: 1, generation: 1 },
    });
    expect(current.find((interview) => interview.id === middle.interviewId)).toMatchObject({ analysis: { status: 'running' } });
  });

  it('ST-08/F1: a captured complete analysis keeps its synthesis while later work continues', async () => {
    const stub = workspaceStub();
    const study = await createStudy();
    const analyzed = await completeInterview(study, T0 - 2 * HOUR);
    await completeInterview(study, T0 - HOUR);
    await analyze(analyzed);
    const begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    await completeInterview(study, T0);
    const pages = await readAll(begun.sequence, 1, 1_000_000);
    const exported = pages.flatMap((page) => page.interviews).find((interview) => interview.id === analyzed.interviewId);
    expect(exported).toMatchObject({ synthesis: SYNTHESIS, aiProvider: 'openai', analysis: { status: 'complete', generation: 1, studyRevision: 1 } });
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'unchanged' });
  });

  it('ST-08/F1: deleting a captured interview (sample clear RPC) makes the next page and the final check report changed', async () => {
    const stub = workspaceStub();
    const study = sampleStudy();
    const fixtures = [sampleInterview(study.id, 'interview-demo-one', T0 - 3 * DAY), sampleInterview(study.id, 'interview-demo-two', T0 - 2 * DAY)];
    expect(await stub.seedSampleWorkspace({ studies: [study], interviews: fixtures, now: T0 })).toMatchObject({ status: 'seeded' });
    const begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const first = await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 1, maxPageBytes: 1_000_000 });
    if (first.status !== 'ok') throw new Error(first.status);
    expect(await stub.clearSampleWorkspace({ studyIds: [study.id], interviewIds: fixtures.map((item) => item.id), now: T0 + DAY }))
      .toMatchObject({ status: 'cleared', interviewsDeleted: 2 });
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: first.nextCursor, pageSize: 1, maxPageBytes: 1_000_000 })).toEqual({ status: 'changed' });
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'changed' });
  });

  it('ST-08/F1: replacing a captured aggregate (saveAggregate RPC) invalidates; an aggregate for an uncaptured study does not', async () => {
    const stub = workspaceStub();
    const withAggregate = await createStudy();
    const without = await createStudy();
    const a = await completeInterview(withAggregate, T0 - 2 * HOUR);
    const b = await completeInterview(without, T0 - HOUR);
    expect(await stub.saveAggregate({ aggregate: aggregate(withAggregate.id, [a.interviewId]), now: T0 })).toBe('saved');

    let begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    expect(begun.studyIds).toEqual([withAggregate.id]);
    expect(await stub.saveAggregate({ aggregate: aggregate(without.id, [b.interviewId]), now: T0 + 1 })).toBe('saved');
    const pages = await readAll(begun.sequence, 5, 1_000_000);
    expect(pages.flatMap((page) => page.aggregates.map((item) => item.studyId))).toEqual([withAggregate.id]);
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'unchanged' });

    begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const interviewPage = await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 5, maxPageBytes: 1_000_000 });
    if (interviewPage.status !== 'ok') throw new Error(interviewPage.status);
    expect(interviewPage.nextCursor).toBe(JSON.stringify(['a', 0]));
    const replacement = { ...aggregate(withAggregate.id, [a.interviewId]), bottomLine: 'replaced' };
    expect(await stub.saveAggregate({ aggregate: replacement, now: T0 + 2 })).toBe('saved');
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: interviewPage.nextCursor, pageSize: 5, maxPageBytes: 1_000_000 })).toEqual({ status: 'changed' });
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'changed' });
  });

  it('ST-08: a streamed export survives concurrent collection, and a captured-row deletion errors it without finalizing', async () => {
    const stub = workspaceStub();
    const study = await createStudy();
    await completeInterview(study, T0 - 2 * HOUR);
    await completeInterview(study, T0 - HOUR);
    const sample = sampleStudy();
    const fixtures = [sampleInterview(sample.id, 'interview-demo-one', T0 - 3 * DAY)];
    expect(await stub.seedSampleWorkspace({ studies: [sample], interviews: fixtures, now: T0 })).toMatchObject({ status: 'seeded' });

    async function exportWith(duringFirstPage: () => Promise<void>): Promise<{ bytes: Uint8Array; error: unknown }> {
      const begun = await stub.beginExport({ maximum: 500 });
      if (begun.status !== 'ok') throw new Error(begun.status);
      const { sequence } = begun;
      async function* pages(): AsyncGenerator<InterviewExportPage> {
        let cursor: string | null = null;
        for (;;) {
          const page = await stub.readExportPage({ sequence, cursor, pageSize: 1, maxPageBytes: 1_000_000 });
          if (page.status === 'changed') throw new ExportSnapshotChangedError();
          if (page.status !== 'ok') throw new Error(page.status);
          yield { interviews: page.interviews, aggregates: page.aggregates };
          if (cursor === null) await duringFirstPage();
          cursor = page.nextCursor;
          if (cursor === null) return;
        }
      }
      const reader = createInterviewExportStream({
        pages: pages(),
        beforeFinish: async () => {
          const verified = await stub.verifyExportSequence({ sequence });
          if (verified.status !== 'unchanged') throw new ExportSnapshotChangedError();
        },
      }).getReader();
      const chunks: Uint8Array[] = [];
      let error: unknown = null;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
      } catch (caught) {
        error = caught;
      }
      return { bytes: new Uint8Array(await new Blob(chunks).arrayBuffer()), error };
    }

    const survived = await exportWith(async () => {
      await completeInterview(study, T0);
    });
    expect(survived.error).toBeNull();
    const zip = await JSZip.loadAsync(survived.bytes, { checkCRC32: true });
    expect(Object.keys(zip.files).filter((name) => name.endsWith('.json'))).toHaveLength(3);

    const failed = await exportWith(async () => {
      await stub.clearSampleWorkspace({ studyIds: [sample.id], interviewIds: [fixtures[0].id], now: T0 + DAY });
    });
    expect(failed.error).toBeInstanceOf(ExportSnapshotChangedError);
    await expect(JSZip.loadAsync(failed.bytes)).rejects.toThrow();
  });

  it('ST-08: a discarded snapshot is recaptured only while the sequence is unchanged', async () => {
    const stub = workspaceStub();
    const study = await createStudy();
    await completeInterview(study, T0 - HOUR);
    const begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    const discard = () => runInDurableObject(workspaceStub(), (_instance, state) => {
      state.storage.kv.delete(`${EXPORT_SNAPSHOT_PREFIX}${begun.sequence}`);
    });
    await discard();
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 5, maxPageBytes: 1_000_000 })).toMatchObject({ status: 'ok' });
    await discard();
    await completeInterview(study, T0);
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 5, maxPageBytes: 1_000_000 })).toEqual({ status: 'changed' });
    expect(await stub.verifyExportSequence({ sequence: begun.sequence })).toEqual({ status: 'changed' });
    // An expired snapshot is discarded the same way.
    const latest = await stub.beginExport({ maximum: 500 });
    if (latest.status !== 'ok') throw new Error(latest.status);
    await runInDurableObject(workspaceStub(), (_instance, state) => {
      const key = `${EXPORT_SNAPSHOT_PREFIX}${latest.sequence}`;
      const stored = state.storage.kv.get<{ capturedAt: number }>(key)!;
      state.storage.kv.put(key, { ...stored, capturedAt: Date.now() - EXPORT_SNAPSHOT_TTL_MS - 1 });
    });
    await withSql(bump);
    expect(await stub.verifyExportSequence({ sequence: latest.sequence })).toEqual({ status: 'changed' });
  });

  it('ST-08: stored snapshots are bounded in number and the capture ceiling is enforced', async () => {
    const stub = workspaceStub();
    const study = await createStudy();
    await completeInterview(study, T0 - HOUR);
    for (let index = 0; index < EXPORT_SNAPSHOT_LIMIT + 3; index += 1) {
      expect(await stub.beginExport({ maximum: 500 })).toMatchObject({ status: 'ok' });
      await withSql(bump);
    }
    expect((await snapshotKeys()).length).toBe(EXPORT_SNAPSHOT_LIMIT);
    expect(await stub.beginExport({ maximum: EXPORT_MAX_INTERVIEWS + 1 })).toEqual({ status: 'unavailable' });
  });

  it('ST-08: a corrupt interview record fails the page instead of silently dropping it; malformed input is refused', async () => {
    const stub = workspaceStub();
    await withSql((sql) => {
      insertStudy(sql, 'study-x');
      insertInterview(sql, record('ok-1', 'study-x', BASE + 1));
      sql.exec(
        `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture)
         VALUES ('bad-1', 'study-x', '{"id":"someone-else"}', ?, ?, ?, 0)`,
        'f'.repeat(64), BASE + 2, BASE + 2,
      );
      bump(sql);
    });
    const begun = await stub.beginExport({ maximum: 500 });
    if (begun.status !== 'ok') throw new Error(begun.status);
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 10, maxPageBytes: 1_000_000 })).toEqual({ status: 'unavailable' });
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: '["i","x"]', pageSize: 10, maxPageBytes: 1_000_000 })).toEqual({ status: 'unavailable' });
    expect(await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 0, maxPageBytes: 1_000_000 })).toEqual({ status: 'unavailable' });
    expect(await stub.beginExport({ maximum: 0 })).toEqual({ status: 'unavailable' });
  });

  it('ST-08: exports stay readable in every maintenance state and under a recovery-epoch mismatch', async () => {
    const stub = workspaceStub();
    await withSql((sql) => {
      insertStudy(sql, 'study-r');
      insertInterview(sql, record('r-1', 'study-r', BASE));
      bump(sql);
    });
    for (const state of ['draining', 'frozen', 'recovery'] as const) {
      await withSql((sql) => sql.exec(`UPDATE workspace_meta SET maintenance_state = ?`, state));
      expect(await stub.beginExport({ maximum: 500 })).toMatchObject({ status: 'ok', count: 1 });
    }
    await withSql((sql) => sql.exec(`UPDATE workspace_meta SET activated_epoch = ?`, `ep_${'9'.repeat(32)}`));
    const begun = await stub.beginExport({ maximum: 500 });
    expect(begun).toMatchObject({ status: 'ok', count: 1 });
    if (begun.status === 'ok') {
      expect(await stub.readExportPage({ sequence: begun.sequence, cursor: null, pageSize: 5, maxPageBytes: 1_000_000 })).toMatchObject({ status: 'ok' });
    }
  });
});
