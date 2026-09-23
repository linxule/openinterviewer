import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import {
  MAX_COLLECTION_BYTES,
  type AggregateInputsRequest,
  type ListInterviewsPage,
  type ListInterviewsRequest,
} from '../../cloudflare/workspace/reads';
import type { StoredInterview } from '../../src/types';
import { workspaceStub } from './helpers';
import {
  captureStoreEvents,
  createStudy,
  DAY,
  mutationSeq,
  sampleInterview,
  setMaintenance,
  sha256Hex,
  sql,
  T0,
} from './fixtures';

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The paged form the durable client sends (the stub's declared input is the port's). */
function listPage(request: ListInterviewsRequest): Promise<ListInterviewsPage> {
  return workspaceStub().listInterviews(request) as Promise<ListInterviewsPage>;
}

function aggregateInputs(request: AggregateInputsRequest) {
  return workspaceStub().readAggregateInputs(request);
}

const SYNTHESIS = {
  statedPreferences: ['Synthetic'],
  revealedPreferences: [],
  themes: [{ theme: 'Synthetic theme', frequency: 2, evidenceRefs: [{ quote: 'Synthetic', turnIndex: 1 }] }],
  contradictions: [],
  keyInsights: [],
  bottomLine: 'Synthetic bottom line.',
};
const PROVENANCE = { aiProvider: 'openai', aiModel: 'gpt-5.6-terra-2031-01-01', requestedAiModel: 'gpt-5.6-terra' };

type Seeded = { record: StoredInterview };

/** Insert an interview row (and optionally its analysis row) exactly as a writer would. */
async function insertInterview(options: {
  studyId: string;
  id?: string;
  createdAt?: number;
  studyRevision?: number;
  revisionColumn?: 'copy' | 'null';
  analysis?: 'pending' | 'complete' | 'none';
  legacySynthesis?: boolean;
}): Promise<Seeded> {
  const id = options.id ?? `session-${crypto.randomUUID()}`;
  const createdAt = options.createdAt ?? T0 - DAY;
  const base = sampleInterview(options.studyId, id, createdAt);
  const record: StoredInterview = {
    ...base,
    studyRevision: options.studyRevision ?? 1,
    synthesis: options.legacySynthesis ? base.synthesis : null,
  };
  await sql(
    `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture, study_revision)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    id,
    options.studyId,
    JSON.stringify(record),
    await sha256Hex(id),
    createdAt,
    createdAt + 1,
    options.revisionColumn === 'null' ? null : record.studyRevision ?? null,
  );
  const analysis = options.analysis ?? 'complete';
  if (analysis !== 'none') {
    await sql(
      `INSERT INTO analysis (interview_id, status, current_generation, attempts, last_attempt_at, failure_kind,
         recovery_required, study_revision, synthesis_json, provenance_json, updated_at)
       VALUES (?, ?, 1, 1, ?, NULL, 0, ?, ?, ?, ?)`,
      id,
      analysis,
      T0,
      analysis === 'complete' ? 1 : null,
      analysis === 'complete' ? JSON.stringify(SYNTHESIS) : null,
      analysis === 'complete' ? JSON.stringify(PROVENANCE) : null,
      T0,
    );
  }
  return { record };
}

function aggregate(studyId: string, overrides: Record<string, unknown> = {}) {
  return {
    studyId,
    studyRevision: 1,
    interviewIds: ['session-synthetic-a', 'session-synthetic-b'],
    interviewCount: 2,
    aiProvider: 'openai' as const,
    aiModel: 'gpt-5.6-terra',
    requestedAiModel: 'gpt-5.6-terra',
    commonThemes: [{ theme: 'Synthetic — 主题', frequency: 2, quoteRefs: [] }],
    divergentViews: [],
    keyFindings: ['Synthetic finding'],
    researchImplications: [],
    bottomLine: 'Synthetic aggregate.',
    generatedAt: T0,
    savedAt: T0,
    ...overrides,
  };
}

describe('interview reads (ST-05, ST-08)', () => {
  it('ST-05: a legacy record without an analysis row reads as stored, distinct from malformed state', async () => {
    const study = await createStudy();
    const { record } = await insertInterview({ studyId: study.id, analysis: 'none', legacySynthesis: true });
    expect(await workspaceStub().getInterview({ interviewId: record.id })).toStrictEqual({ status: 'found', interview: record });
    expect(await workspaceStub().getInterview({ interviewId: 'session-missing' })).toEqual({ status: 'not-found' });
    expect(await workspaceStub().getInterview({ interviewId: '../bad id' })).toEqual({ status: 'not-found' });
  });

  it('ST-05: a complete analysis row supplies synthesis and actual provenance over the immutable record', async () => {
    const study = await createStudy();
    const { record } = await insertInterview({ studyId: study.id, analysis: 'complete' });
    const read = await workspaceStub().getInterview({ interviewId: record.id });
    expect(read).toStrictEqual({
      status: 'found',
      interview: {
        ...record,
        synthesis: SYNTHESIS,
        aiProvider: 'openai',
        aiModel: 'gpt-5.6-terra-2031-01-01',
        requestedAiModel: 'gpt-5.6-terra',
        analysis: { status: 'complete', attempts: 1, lastAttemptAt: T0, generation: 1, studyRevision: 1 },
      },
    });
  });

  it('ST-05: a malformed immutable record is unavailable alone, left out of lists (Redis parity) and left unchanged', async () => {
    const study = await createStudy();
    const good = await insertInterview({ studyId: study.id, createdAt: T0 - 3 * DAY });
    const badRecord = await insertInterview({ studyId: study.id, createdAt: T0 - 2 * DAY });
    await sql(`UPDATE interviews SET record_json = '{"id":"truncated' WHERE id = ?`, badRecord.record.id);
    const before = await sql(`SELECT * FROM interviews ORDER BY id`);
    const events = captureStoreEvents();

    expect(await workspaceStub().getInterview({ interviewId: badRecord.record.id })).toEqual({ status: 'unavailable' });
    const listed = await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 10 });
    expect(listed.status === 'ok' && listed.items.map((item) => item.id)).toEqual([good.record.id]);

    expect(events()).toEqual([
      expect.objectContaining({ reason: 'corrupt-record', operation: 'getInterview' }),
      expect.objectContaining({ reason: 'corrupt-record', operation: 'listInterviews' }),
    ]);
    expect(JSON.stringify(events())).not.toContain('truncated');
    expect(await sql(`SELECT * FROM interviews ORDER BY id`)).toEqual(before);
  });

  it('ST-05: malformed analysis state refuses the collection instead of hiding an intact transcript', async () => {
    const study = await createStudy();
    await insertInterview({ studyId: study.id, createdAt: T0 - 3 * DAY });
    const badAnalysis = await insertInterview({ studyId: study.id, createdAt: T0 - DAY });
    await sql(`UPDATE analysis SET synthesis_json = NULL WHERE interview_id = ?`, badAnalysis.record.id);
    const before = await sql(`SELECT * FROM interviews ORDER BY id`);
    const analysisBefore = await sql(`SELECT * FROM analysis ORDER BY interview_id`);
    const events = captureStoreEvents();

    expect(await workspaceStub().getInterview({ interviewId: badAnalysis.record.id })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 10 }))
      .toEqual({ status: 'unavailable' });
    expect(await workspaceStub().listInterviews({ scope: 'all', maximum: 10 })).toEqual({ status: 'unavailable' });
    expect(await listPage({ scope: 'all', maximum: 10, page: { cursor: null, maxPageBytes: MAX_COLLECTION_BYTES } }))
      .toEqual({ status: 'unavailable' });

    expect(events().filter((event) => event.operation === 'listInterviews')).toHaveLength(3);
    expect(events().every((event) => event.reason === 'corrupt-record')).toBe(true);
    expect(await sql(`SELECT * FROM interviews ORDER BY id`)).toEqual(before);
    expect(await sql(`SELECT * FROM analysis ORDER BY interview_id`)).toEqual(analysisBefore);
  });

  it('ST-05: a valid exhausted attempt counter reads normally while a malformed counter is corrupt', async () => {
    const study = await createStudy();
    const exhausted = await insertInterview({ studyId: study.id, analysis: 'pending' });
    const malformed = await insertInterview({ studyId: study.id, analysis: 'pending' });
    await sql(`UPDATE analysis SET attempts = ? WHERE interview_id = ?`, Number.MAX_SAFE_INTEGER, exhausted.record.id);
    await sql(`UPDATE analysis SET attempts = 1.5 WHERE interview_id = ?`, malformed.record.id);

    const read = await workspaceStub().getInterview({ interviewId: exhausted.record.id });
    expect(read.status === 'found' && read.interview.analysis?.attempts).toBe(Number.MAX_SAFE_INTEGER);
    expect(await workspaceStub().getInterview({ interviewId: malformed.record.id })).toEqual({ status: 'unavailable' });
  });

  it('ST-08: collections count first, order newest first with an id tie-break, and scope by study', async () => {
    const study = await createStudy();
    const other = await createStudy();
    const a = await insertInterview({ studyId: study.id, id: 'session-a', createdAt: T0 - 10 });
    const b = await insertInterview({ studyId: study.id, id: 'session-b', createdAt: T0 - 10 });
    const c = await insertInterview({ studyId: study.id, id: 'session-c', createdAt: T0 - 20 });
    const d = await insertInterview({ studyId: other.id, id: 'session-d', createdAt: T0 });

    expect(await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 2 }))
      .toEqual({ status: 'too-large', count: 3, maximum: 2 });
    const scoped = await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 3 });
    expect(scoped.status === 'ok' && scoped.items.map((item) => item.id)).toEqual([b.record.id, a.record.id, c.record.id]);
    const all = await workspaceStub().listInterviews({ scope: 'all', maximum: 500 });
    expect(all.status === 'ok' && all.items.map((item) => item.id)).toEqual([d.record.id, b.record.id, a.record.id, c.record.id]);
    expect(await workspaceStub().listInterviews({ scope: 'study', studyId: 'no-such-study', maximum: 5 }))
      .toEqual({ status: 'ok', items: [] });
  });

  /** Insert `rows` large records whose message text is ASCII plus one emoji (serialized as UTF-16 over RPC). */
  async function insertLargeRecords(studyId: string, rows: number, messageChars: number): Promise<number> {
    return runInDurableObject(workspaceStub(), (_instance, state) => {
      const content = `${'x'.repeat(messageChars - 2)}🧪`;
      let total = 0;
      for (let index = 0; index < rows; index += 1) {
        const id = `session-big-${index}`;
        const transcript = Array.from({ length: 10 }, (_, turn) => ({ id: `m${turn}`, role: 'user', content, timestamp: T0 }));
        const recordJson = JSON.stringify({ ...sampleInterview(studyId, id, T0 - index), transcript });
        total += new TextEncoder().encode(recordJson).byteLength;
        state.storage.sql.exec(
          `INSERT INTO interviews (id, study_id, record_json, fingerprint, created_at, completed_at, sample_fixture, study_revision)
           VALUES (?, ?, ?, 'fp', ?, ?, 0, 1)`,
          id,
          studyId,
          recordJson,
          T0 - index,
          T0,
        );
      }
      return total;
    });
  }

  it('ST-08: a collection just inside the byte budget crosses RPC intact even when every string is two-byte', async () => {
    const study = await createStudy();
    const total = await insertLargeRecords(study.id, 7, 170_000);
    expect(total).toBeLessThanOrEqual(MAX_COLLECTION_BYTES);
    expect(total).toBeGreaterThan(MAX_COLLECTION_BYTES * 0.9);
    const listed = await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 1_000 });
    expect(listed.status === 'ok' && listed.items.length).toBe(7);
  });

  it('ST-08: an unpaged request whose collection needs more than one response is too-large, never truncated', async () => {
    const study = await createStudy();
    const total = await insertLargeRecords(study.id, 8, 170_000);
    expect(total).toBeGreaterThan(MAX_COLLECTION_BYTES);
    expect(await workspaceStub().listInterviews({ scope: 'study', studyId: study.id, maximum: 1_000 }))
      .toEqual({ status: 'too-large', count: 8, maximum: 1_000 });
  });

  it('ST-08: paged requests return every row of a collection beyond one response, newest first, once each', async () => {
    const study = await createStudy();
    const total = await insertLargeRecords(study.id, 8, 170_000);
    expect(total).toBeGreaterThan(MAX_COLLECTION_BYTES);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListInterviewsPage = await listPage({
        scope: 'study', studyId: study.id, maximum: 1_000, page: { cursor, maxPageBytes: MAX_COLLECTION_BYTES },
      });
      if (page.status !== 'ok') throw new Error(page.status);
      expect(page.count).toBe(8);
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(2);
    expect(seen).toEqual(Array.from({ length: 8 }, (_, index) => `session-big-${index}`));
  });

  it('ST-08: a small page budget pages one row at a time and the count is re-checked on every page', async () => {
    const study = await createStudy();
    for (let index = 0; index < 3; index += 1) {
      await insertInterview({ studyId: study.id, id: `session-q${index}`, createdAt: T0 - index });
    }
    const first = await listPage({ scope: 'study', studyId: study.id, maximum: 3, page: { cursor: null, maxPageBytes: 1 } });
    expect(first.status === 'ok' && [first.items.map((item) => item.id), first.nextCursor, first.count])
      .toEqual([['session-q0'], `${T0}:session-q0`, 3]);

    // A row committed between pages that pushes the scope past the maximum refuses the next page.
    await insertInterview({ studyId: study.id, id: 'session-q9', createdAt: T0 - 9 });
    const next = await listPage({
      scope: 'study', studyId: study.id, maximum: 3, page: { cursor: first.status === 'ok' ? first.nextCursor : null, maxPageBytes: 1 },
    });
    expect(next).toEqual({ status: 'too-large', count: 4, maximum: 3 });

    expect(await listPage({ scope: 'study', studyId: study.id, maximum: 10, page: { cursor: 'not-a-cursor', maxPageBytes: 1 } }))
      .toEqual({ status: 'unavailable' });
    expect(await listPage({ scope: 'study', studyId: study.id, maximum: 10, page: { cursor: null, maxPageBytes: 0 } }))
      .toEqual({ status: 'unavailable' });
  });

  it('OPS-01: reads continue in every maintenance state', async () => {
    const study = await createStudy();
    const { record } = await insertInterview({ studyId: study.id });
    await setMaintenance('recovery');
    expect((await workspaceStub().getInterview({ interviewId: record.id })).status).toBe('found');
    expect((await workspaceStub().listInterviews({ scope: 'all', maximum: 10 })).status).toBe('ok');
  });
});

describe('aggregate persistence (ST-07, ST-08)', () => {
  it('ST-08: an aggregate round-trips exactly, the latest replaces, and each write advances the mutation sequence', async () => {
    const study = await createStudy();
    const seq = await mutationSeq();
    const first = aggregate(study.id);
    expect(await workspaceStub().saveAggregate({ aggregate: first, now: T0 })).toBe('saved');
    expect(await workspaceStub().getAggregate({ studyId: study.id })).toStrictEqual({ status: 'found', aggregate: first });
    const second = aggregate(study.id, { bottomLine: 'Replaced synthetic aggregate.', savedAt: T0 + 1 });
    expect(await workspaceStub().saveAggregate({ aggregate: second, now: T0 + 1 })).toBe('saved');
    expect(await workspaceStub().getAggregate({ studyId: study.id })).toStrictEqual({ status: 'found', aggregate: second });
    expect(await mutationSeq()).toBe(seq + 2);
  });

  it('ST-08: the 256,000-byte serialized ceiling refuses before any write', async () => {
    const study = await createStudy();
    const base = aggregate(study.id);
    const room = 256_000 - new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const exact = aggregate(study.id, { bottomLine: base.bottomLine + 'x'.repeat(room) });
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(256_000);
    expect(await workspaceStub().saveAggregate({ aggregate: exact, now: T0 })).toBe('saved');
    const over = aggregate(study.id, { bottomLine: exact.bottomLine + 'x' });
    expect(await workspaceStub().saveAggregate({ aggregate: over, now: T0 })).toBe('too-large');
    const [row] = await sql<{ aggregate_json: string }>(`SELECT aggregate_json FROM aggregates`);
    expect(row.aggregate_json).toBe(JSON.stringify(exact));
  });

  it('ST-07: a missing or deleted study refuses the aggregate write', async () => {
    const study = await createStudy();
    expect(await workspaceStub().saveAggregate({ aggregate: aggregate('d0000000-0000-4000-8000-000000000000'), now: T0 }))
      .toBe('study-not-found');
    await workspaceStub().deleteStudy({ studyId: study.id, now: T0 });
    expect(await workspaceStub().saveAggregate({ aggregate: aggregate(study.id), now: T0 })).toBe('study-not-found');
    expect(await workspaceStub().getAggregate({ studyId: study.id })).toEqual({ status: 'not-found' });
  });

  it('ST-05: an aggregate that does not decode is absent and an invalid one is never stored', async () => {
    const study = await createStudy();
    expect(await workspaceStub().saveAggregate({ aggregate: aggregate(study.id, { interviewIds: [], interviewCount: 0 }), now: T0 }))
      .toBe('unavailable');
    await sql(
      `INSERT INTO aggregates (study_id, aggregate_json, saved_at) VALUES (?, ?, ?)`,
      study.id,
      JSON.stringify(aggregate('some-other-study')),
      T0,
    );
    expect(await workspaceStub().getAggregate({ studyId: study.id })).toEqual({ status: 'not-found' });
  });

  it('OPS-01: aggregate writes are researcher mutations and are held outside open', async () => {
    const study = await createStudy();
    await setMaintenance('draining');
    expect(await workspaceStub().saveAggregate({ aggregate: aggregate(study.id), now: T0 })).toBe('held');
  });
});

describe('aggregate inputs (ST-08)', () => {
  it('ST-08: selects analyzed current-revision interviews, including legacy synthesized records', async () => {
    const study = await createStudy();
    const complete = await insertInterview({ studyId: study.id, id: 'session-complete', createdAt: T0 - 1 });
    const legacy = await insertInterview({ studyId: study.id, id: 'session-legacy', createdAt: T0 - 2, analysis: 'none', legacySynthesis: true });
    const fallback = await insertInterview({ studyId: study.id, id: 'session-fallback', createdAt: T0 - 3, revisionColumn: 'null' });
    await insertInterview({ studyId: study.id, id: 'session-pending', createdAt: T0 - 4, analysis: 'pending' });
    await insertInterview({ studyId: study.id, id: 'session-old-revision', createdAt: T0 - 5, studyRevision: 2 });
    await insertInterview({ studyId: study.id, id: 'session-unsynthesized-legacy', createdAt: T0 - 6, analysis: 'none' });

    const page = await workspaceStub().readAggregateInputs({
      studyId: study.id, studyRevision: 1, cursor: null, pageSize: 10, maxPageBytes: 1_000_000,
    });
    if (page.status !== 'ok') throw new Error(page.status);
    expect(page.totalEligible).toBe(3);
    expect(page.nextCursor).toBeNull();
    expect(page.interviews.map((item) => item.id)).toEqual([complete.record.id, legacy.record.id, fallback.record.id]);
    expect(page.interviews[0].synthesis).toStrictEqual(SYNTHESIS);
    expect(page.interviews[1]).toStrictEqual(legacy.record);
  });

  it('ST-08: keyset pages honour page size and byte budget without skipping or repeating rows', async () => {
    const study = await createStudy();
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const { record } = await insertInterview({ studyId: study.id, id: `session-p${index}`, createdAt: T0 - (index < 3 ? 0 : index) });
      ids.push(record.id);
    }
    const expectedOrder = [...ids].sort((left, right) => {
      const createdLeft = T0 - (Number(left.slice(9)) < 3 ? 0 : Number(left.slice(9)));
      const createdRight = T0 - (Number(right.slice(9)) < 3 ? 0 : Number(right.slice(9)));
      return createdRight - createdLeft || (right < left ? -1 : 1);
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await workspaceStub().readAggregateInputs({ studyId: study.id, studyRevision: 1, cursor, pageSize: 3, maxPageBytes: 1 });
      if (page.status !== 'ok') throw new Error(page.status);
      // A one-byte budget still makes progress one row per page.
      expect(page.interviews).toHaveLength(1);
      expect(page.totalEligible).toBe(7);
      seen.push(...page.interviews.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 20);
    expect(seen).toEqual(expectedOrder);

    const bySize = await workspaceStub().readAggregateInputs({ studyId: study.id, studyRevision: 1, cursor: null, pageSize: 3, maxPageBytes: 1_000_000 });
    expect(bySize.status === 'ok' && [bySize.interviews.length, bySize.nextCursor !== null]).toEqual([3, true]);
  });

  it('OPS-01: inputs for paid follow-up are fenced like job work: refused when frozen, in recovery or under an epoch mismatch', async () => {
    const study = await createStudy();
    await insertInterview({ studyId: study.id, id: 'session-fenced' });
    const request = { studyId: study.id, studyRevision: 1, cursor: null, pageSize: 10, maxPageBytes: 1_000_000 };

    await setMaintenance('draining');
    const draining = await aggregateInputs(request);
    expect(draining.status === 'ok' && draining.totalEligible).toBe(1);
    expect((await aggregateInputs({ ...request, purpose: 'follow-up' })).status).toBe('ok');
    // Aggregate synthesis ends in a researcher mutation, which draining refuses: refuse before the provider is paid.
    expect(await aggregateInputs({ ...request, purpose: 'aggregate' })).toEqual({ status: 'unavailable' });

    for (const state of ['frozen', 'recovery'] as const) {
      await setMaintenance(state);
      expect(await aggregateInputs(request)).toEqual({ status: 'unavailable' });
      expect(await aggregateInputs({ ...request, purpose: 'aggregate' })).toEqual({ status: 'unavailable' });
    }

    await setMaintenance('open');
    expect((await aggregateInputs({ ...request, purpose: 'aggregate' })).status).toBe('ok');
    await sql(`UPDATE workspace_meta SET activated_epoch = ?`, 'ep_ffffffffffffffffffffffffffffffff');
    expect(await aggregateInputs(request)).toEqual({ status: 'unavailable' });
    // Plain reads stay available for inspection under the mismatch.
    expect((await workspaceStub().getInterview({ interviewId: 'session-fenced' })).status).toBe('found');
  });

  it('ST-05/ST-08: a corrupt eligible row fails the page rather than silently shrinking the aggregate set', async () => {
    const study = await createStudy();
    await insertInterview({ studyId: study.id, id: 'session-ok', createdAt: T0 - 1 });
    const { record } = await insertInterview({ studyId: study.id, id: 'session-corrupt', createdAt: T0 - 2 });
    await sql(`UPDATE analysis SET provenance_json = '{' WHERE interview_id = ?`, record.id);
    expect(await workspaceStub().readAggregateInputs({ studyId: study.id, studyRevision: 1, cursor: null, pageSize: 10, maxPageBytes: 1_000_000 }))
      .toEqual({ status: 'unavailable' });
    expect(await workspaceStub().readAggregateInputs({ studyId: study.id, studyRevision: 1, cursor: 'garbage', pageSize: 10, maxPageBytes: 10 }))
      .toEqual({ status: 'unavailable' });
  });
});
