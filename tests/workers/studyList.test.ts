// Study lists past one RPC response (ST-08). The object pages studies by
// keyset over (created_at DESC, id DESC) within a stored-byte budget and
// replies with list items, never whole configurations; the durable client
// assembles pages up to a Worker byte ceiling and answers too-large past it.
// Every RPC here crosses real workerd, whose 32 MiB limit refused the
// single-response list of 300 maximum-size studies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import type { ListStudiesPage } from '../../cloudflare/workspace/studies';
import {
  MAX_COLLECTION_BYTES,
  STUDY_PAGE_OVERHEAD_BYTES,
} from '../../cloudflare/workspace/studies';
import {
  createDurableWorkspaceStore,
  LIST_STUDIES_PAGE_BYTES,
  MAX_LIST_STUDIES_BYTES,
} from '../../src/lib/storage/durableObject';
import { STUDY_MUTATION_MAX_BYTES, validateStudyConfigForCreate } from '../../src/lib/studyConfigValidation';
import { toStudyListItem, type StudyConfig, type StudyListItem } from '../../src/types';
import { testEnv, workspaceStub } from './helpers';
import { captureStoreEvents, DAY, sql, studyConfig, T0 } from './fixtures';

const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';
const RPC_LIMIT_BYTES = 32 * 1024 * 1024;

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();

function cursorAt(createdAt: number | string, id: string): string {
  return JSON.stringify([createdAt, id]);
}

function studyId(index: number): string {
  return `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** A valid study config just under the 128 KiB create body cap: every long field near its maximum. */
function largeConfig(id: string): StudyConfig {
  return studyConfig(id, {
    description: 'd'.repeat(10_000),
    researchQuestion: 'q'.repeat(4_000),
    consentText: 'c'.repeat(20_000),
    coreQuestions: Array.from({ length: 45 }, (_, index) => `${index}`.padEnd(2_000, 'x')),
  });
}

/** The list item insertLargeStudies' study `index` lists as. */
function listItem(index: number): StudyListItem {
  const id = studyId(index);
  return toStudyListItem({
    id, config: largeConfig(id), createdAt: T0 - index, updatedAt: T0 - index, interviewCount: 0, isLocked: false, revision: 1,
  });
}

type Row = { id: string; config: StudyConfig; createdAt: number };

/** Insert rows directly: the create path's receipt quota would stop at 100. */
async function insertStudies(rows: Row[]): Promise<void> {
  await workspaceStub().readiness();
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    for (const row of rows) {
      state.storage.sql.exec(
        `INSERT INTO studies (id, config_json, revision, created_at, updated_at, interview_count, is_locked, sample_fixture)
         VALUES (?, ?, 1, ?, ?, 0, 0, 0)`,
        row.id,
        JSON.stringify(row.config),
        row.createdAt,
        row.createdAt,
      );
    }
  });
}

async function insertLargeStudies(rows: number): Promise<number> {
  const all = Array.from({ length: rows }, (_, index) => ({ id: studyId(index), config: largeConfig(studyId(index)), createdAt: T0 - index }));
  await insertStudies(all);
  return all.reduce((total, row) => total + encoder.encode(JSON.stringify(row.config)).byteLength, 0);
}

async function insertSmallStudies(createdAts: number[]): Promise<string[]> {
  const rows = createdAts.map((createdAt, index) => ({ id: studyId(index), config: studyConfig(studyId(index)), createdAt }));
  await insertStudies(rows);
  return rows.map((row) => row.id);
}

function listPage(input: { maximum: number; page?: { cursor: string | null; maxPageBytes: number } }): Promise<ListStudiesPage> {
  return workspaceStub().listStudies(input) as Promise<ListStudiesPage>;
}

async function okPage(input: { maximum: number; page: { cursor: string | null; maxPageBytes: number } }) {
  const page = await listPage(input);
  if (page.status !== 'ok') throw new Error(page.status);
  return page;
}

/** Forwards to the real object, recording each reply's row count and serialized size. */
function recordingNamespace() {
  const calls: Array<{ input: unknown; rows: number | null; replyBytes: number }> = [];
  const namespace = {
    getByName(name: string) {
      const real = testEnv.WORKSPACE_STORE.getByName(name) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
      return new Proxy({}, {
        get(_target, method: string) {
          return async (input?: unknown) => {
            const reply = await real[method](input);
            const items = (reply as { items?: unknown } | null)?.items;
            calls.push({
              input,
              rows: Array.isArray(items) ? items.length : null,
              replyBytes: encoder.encode(JSON.stringify(reply)).byteLength,
            });
            return reply;
          };
        },
      });
    },
  };
  return { namespace, calls };
}

function storeOn(namespace: unknown) {
  return createDurableWorkspaceStore({ namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
}

describe('study lists in workerd (ST-08)', () => {
  it('ST-08: the large study config fixture is valid and within the create body cap', () => {
    const config = largeConfig(studyId(0));
    expect(validateStudyConfigForCreate(config, { id: config.id, createdAt: config.createdAt }).ok).toBe(true);
    const body = encoder.encode(JSON.stringify({ config })).byteLength;
    expect(body).toBeLessThanOrEqual(STUDY_MUTATION_MAX_BYTES);
    expect(body).toBeGreaterThan(0.9 * STUDY_MUTATION_MAX_BYTES);
  });

  it('ST-08: 300 maximum-size studies (about 37 MB) list in full as items, never a failed RPC or a 413', async () => {
    const bytes = await insertLargeStudies(300);
    expect(bytes).toBeGreaterThan(RPC_LIMIT_BYTES);
    const events = captureStoreEvents();

    const { namespace, calls } = recordingNamespace();
    const listed = await storeOn(namespace).listStudies(1_000);
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.items.map((study) => study.id)).toEqual(Array.from({ length: 300 }, (_, index) => studyId(index)));
    expect(listed.items[0]).toEqual(listItem(0));
    expect(listed.items[0]).not.toHaveProperty('config.consentText');
    // Each page loads at most its budget and replies with far less.
    const assembled = encoder.encode(JSON.stringify(listed.items)).byteLength;
    expect(assembled).toBeLessThan(bytes / 10);
    expect(calls.every((call) => (call.input as { page: { maxPageBytes: number } }).page.maxPageBytes === LIST_STUDIES_PAGE_BYTES)).toBe(true);
    expect(Math.max(...calls.map((call) => call.replyBytes))).toBeLessThan(1024 * 1024);
    expect(events().filter((event) => event.reason === 'unavailable')).toEqual([]);
  });

  it('ST-08: the route maximum of 1,000 maximum-size studies (about 124 MB stored) lists in full', async () => {
    const bytes = await insertLargeStudies(1_000);
    expect(bytes).toBeGreaterThan(3 * RPC_LIMIT_BYTES);

    const listed = await storeOn(testEnv.WORKSPACE_STORE).listStudies(1_000);
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.items).toHaveLength(1_000);
    expect(listed.items.at(-1)).toEqual(listItem(999));
    expect(encoder.encode(JSON.stringify(listed.items)).byteLength).toBeLessThan(MAX_LIST_STUDIES_BYTES);
    expect(await storeOn(testEnv.WORKSPACE_STORE).listStudies(999)).toEqual({ status: 'too-large', count: 1_000, maximum: 999 });
  });

  it('ST-08: past the Worker ceiling (1,000 studies with 10,000-character CJK descriptions) the list is too-large, never partial', async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: studyId(index),
      config: studyConfig(studyId(index), { description: '研'.repeat(10_000) }),
      createdAt: T0 - index,
    }));
    expect(validateStudyConfigForCreate(rows[0].config, { id: rows[0].id, createdAt: rows[0].config.createdAt }).ok).toBe(true);
    await insertStudies(rows);
    const items = encoder.encode(JSON.stringify(rows.map((row) => toStudyListItem({
      id: row.id, config: row.config, createdAt: row.createdAt, updatedAt: row.createdAt, interviewCount: 0, isLocked: false, revision: 1,
    })))).byteLength;
    expect(items).toBeGreaterThan(MAX_LIST_STUDIES_BYTES);

    expect(await storeOn(testEnv.WORKSPACE_STORE).listStudies(1_000)).toEqual({ status: 'too-large', count: 1_000, maximum: 1_000 });
  });

  it('ST-08: an unpaged request whose studies exceed one response is too-large at the object, never a reply past the RPC limit', async () => {
    const bytes = await insertLargeStudies(300);
    expect(bytes).toBeGreaterThan(RPC_LIMIT_BYTES);
    expect(await listPage({ maximum: 1_000 })).toEqual({ status: 'too-large', count: 300, maximum: 1_000 });
  });

  it('ST-08: studies spanning several pages load intact, newest first, once each', async () => {
    const rows = 80;
    const bytes = await insertLargeStudies(rows);
    expect(bytes).toBeGreaterThan(2 * LIST_STUDIES_PAGE_BYTES);

    const { namespace, calls } = recordingNamespace();
    const listed = await storeOn(namespace).listStudies(1_000);
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.items).toEqual(Array.from({ length: rows }, (_, index) => listItem(index)));
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('listStudies keyset pages (ST-08)', () => {
  /** The page cost of each study newest first, as the object budgets it. */
  async function costs(): Promise<number[]> {
    const rows = await sql<{ bytes: number }>(
      `SELECT octet_length(config_json) AS bytes FROM studies ORDER BY created_at DESC, id DESC`,
    );
    return rows.map((row) => row.bytes + STUDY_PAGE_OVERHEAD_BYTES);
  }

  /** Every id a full paging pass returns, following cursors from `cursor`. */
  async function drain(maxPageBytes: number, cursor: string | null = null, maximum = 1_000): Promise<string[]> {
    const seen: string[] = [];
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await okPage({ maximum, page: { cursor, maxPageBytes } });
      seen.push(...page.items.map((study) => study.id));
      if (page.nextCursor === null) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('paging did not finish');
  }

  it('ST-08: an empty workspace is one final empty page', async () => {
    await workspaceStub().readiness();
    expect(await listPage({ maximum: 10, page: { cursor: null, maxPageBytes: LIST_STUDIES_PAGE_BYTES } }))
      .toEqual({ status: 'ok', items: [], nextCursor: null, count: 0 });
  });

  it('ST-08: a budget that exactly fits some rows ends the page there; one that fits all rows ends the listing', async () => {
    const ids = await insertSmallStudies([T0 - 1, T0 - 2, T0 - 3]);
    const [first, second, third] = await costs();

    const exact = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: first + second } });
    expect([exact.items.map((study) => study.id), exact.nextCursor, exact.count]).toEqual([[ids[0], ids[1]], cursorAt(T0 - 2, ids[1]), 3]);
    const rest = await okPage({ maximum: 10, page: { cursor: exact.nextCursor, maxPageBytes: first + second } });
    expect([rest.items.map((study) => study.id), rest.nextCursor]).toEqual([[ids[2]], null]);

    const oneShort = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: first + second - 1 } });
    expect(oneShort.items.map((study) => study.id)).toEqual([ids[0]]);

    const whole = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: first + second + third } });
    expect([whole.items.map((study) => study.id), whole.nextCursor]).toEqual([ids, null]);
  });

  it('ST-08: a study larger than the page budget is a page by itself, so paging always advances', async () => {
    const all = [0, 1, 2].map((index) => ({ id: studyId(index), config: largeConfig(studyId(index)), createdAt: T0 - index }));
    await insertStudies(all);
    const [largest] = await costs();
    expect(largest).toBeGreaterThan(1_000);

    const page = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: 1_000 } });
    expect([page.items.map((study) => study.id), page.nextCursor]).toEqual([[studyId(0)], cursorAt(T0, studyId(0))]);
    expect(await drain(1)).toEqual(all.map((row) => row.id));
  });

  it('ST-08: equal creation times page by id without skipping or repeating a study', async () => {
    const ids = await insertSmallStudies([T0, T0, T0, T0 - 1]);
    expect(await drain(1)).toEqual([ids[2], ids[1], ids[0], ids[3]]);
  });

  it('ST-08: studies created or deleted between pages never shift the cursor; studies present throughout appear exactly once', async () => {
    const ids = await insertSmallStudies([T0 - 10, T0 - 20, T0 - 30, T0 - 40]);
    const first = await okPage({ maximum: 100, page: { cursor: null, maxPageBytes: 1 } });
    expect(first.items.map((study) => study.id)).toEqual([ids[0]]);

    // Between pages: a newer study (behind the cursor), an older one (ahead of it),
    // a deleted study already returned and a deleted study not yet reached.
    const newer = 'c0000000-0000-4000-8000-000000000001';
    const older = 'c0000000-0000-4000-8000-000000000002';
    await insertStudies([
      { id: newer, config: studyConfig(newer), createdAt: T0 },
      { id: older, config: studyConfig(older), createdAt: T0 - 50 },
    ]);
    await sql(`DELETE FROM studies WHERE id IN (?, ?)`, ids[0], ids[2]);

    const rest = await drain(1, first.nextCursor);
    expect(rest).toEqual([ids[1], ids[3], older]);
    expect(new Set([ids[0], ...rest]).size).toBe(4);
  });

  it('ST-08: every page re-counts the collection against the maximum', async () => {
    await insertSmallStudies([T0 - 1, T0 - 2, T0 - 3]);
    const first = await okPage({ maximum: 3, page: { cursor: null, maxPageBytes: 1 } });
    const extra = 'c0000000-0000-4000-8000-000000000003';
    await insertStudies([{ id: extra, config: studyConfig(extra), createdAt: T0 - DAY }]);
    expect(await listPage({ maximum: 3, page: { cursor: first.nextCursor, maxPageBytes: 1 } }))
      .toEqual({ status: 'too-large', count: 4, maximum: 3 });
  });

  it('ST-08: an undecodable study is left out while the cursor still moves past it', async () => {
    const ids = await insertSmallStudies([T0 - 1, T0 - 2, T0 - 3]);
    await sql(`UPDATE studies SET config_json = ? WHERE id = ?`, '{"id":', ids[1]);
    captureStoreEvents();
    const second = await okPage({ maximum: 10, page: { cursor: cursorAt(T0 - 1, ids[0]), maxPageBytes: 1 } });
    expect([second.items, second.nextCursor]).toEqual([[], cursorAt(T0 - 2, ids[1])]);
    expect(await drain(1)).toEqual([ids[0], ids[2]]);
  });

  it('ST-08: a malformed id or creation time on the last row of a page neither fails nor stalls the listing', async () => {
    const ids = await insertSmallStudies([T0 - 1, T0 - 2, T0 - 3, T0 - 4, 1]);
    await sql(`UPDATE studies SET id = 'bad id!' WHERE id = ?`, ids[1]);
    await sql(`UPDATE studies SET created_at = 7.5 WHERE id = ?`, ids[2]);
    // SQLite keeps non-numeric text in an INTEGER column and sorts it above every number.
    await sql(`UPDATE studies SET created_at = 'not a time' WHERE id = ?`, ids[3]);
    captureStoreEvents();

    // One row per page: each malformed row ends a page, and the cursor is built from it.
    const first = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: 1 } });
    expect([first.items, first.nextCursor]).toEqual([[], cursorAt('not a time', ids[3])]);
    expect(await drain(1)).toEqual([ids[0], ids[4]]);
    expect(await drain(LIST_STUDIES_PAGE_BYTES)).toEqual([ids[0], ids[4]]);
    const listed = await storeOn(testEnv.WORKSPACE_STORE).listStudies(1_000);
    expect(listed.status === 'ok' && listed.items.map((study) => study.id)).toEqual([ids[0], ids[4]]);
  });

  it('ST-08: malformed page requests are unavailable and the object caps any requested budget', async () => {
    await insertSmallStudies([T0 - 1]);
    for (const page of [
      { cursor: 'not-a-cursor', maxPageBytes: 1 },
      { cursor: `${T0}:${studyId(0)}`, maxPageBytes: 1 },
      { cursor: JSON.stringify([T0]), maxPageBytes: 1 },
      { cursor: JSON.stringify([null, studyId(0)]), maxPageBytes: 1 },
      { cursor: JSON.stringify([T0, 7]), maxPageBytes: 1 },
      { cursor: JSON.stringify({ createdAt: T0, id: studyId(0) }), maxPageBytes: 1 },
      { cursor: null, maxPageBytes: 0 },
      { cursor: null, maxPageBytes: 1.5 },
      { cursor: 7, maxPageBytes: 1 },
    ]) {
      expect(await listPage({ maximum: 10, page: page as { cursor: string | null; maxPageBytes: number } }))
        .toEqual({ status: 'unavailable' });
    }
    const huge = await okPage({ maximum: 10, page: { cursor: null, maxPageBytes: Number.MAX_SAFE_INTEGER } });
    expect(huge.items).toHaveLength(1);
    expect(MAX_COLLECTION_BYTES * 2).toBeLessThan(RPC_LIMIT_BYTES);
  });
});

describe('durable client study list assembly (ST-08)', () => {
  function fakeNamespace(answer: (input: { page: { cursor: string | null; maxPageBytes: number } }) => unknown) {
    const calls: unknown[] = [];
    const namespace = {
      getByName: () => new Proxy({}, {
        get: () => async (input: { page: { cursor: string | null; maxPageBytes: number } }) => {
          calls.push(input);
          return answer(input);
        },
      }),
    };
    return { namespace, calls };
  }

  const study = (id: string) => ({ id }) as unknown as StudyListItem;

  it('ST-08: concatenates pages by cursor and refuses inconsistent or oversized paging', async () => {
    captureStoreEvents();
    const pages: Record<string, unknown> = {
      start: { status: 'ok', items: [study('c'), study('b')], nextCursor: '2:b', count: 3 },
      '2:b': { status: 'ok', items: [study('a')], nextCursor: null, count: 3 },
    };
    const fake = fakeNamespace((input) => pages[input.page.cursor ?? 'start']);
    expect(await storeOn(fake.namespace).listStudies(3)).toEqual({ status: 'ok', items: [study('c'), study('b'), study('a')] });
    expect(fake.calls).toEqual([
      { maximum: 3, page: { cursor: null, maxPageBytes: LIST_STUDIES_PAGE_BYTES } },
      { maximum: 3, page: { cursor: '2:b', maxPageBytes: LIST_STUDIES_PAGE_BYTES } },
    ]);
    // Studies created between pages can push the assembled total past the maximum.
    expect(await storeOn(fake.namespace).listStudies(2)).toEqual({ status: 'too-large', count: 3, maximum: 2 });

    const stuck = fakeNamespace(() => ({ status: 'ok', items: [study('x')], nextCursor: '1:x', count: 5 }));
    expect(await storeOn(stuck.namespace).listStudies(5)).toEqual({ status: 'unavailable' });

    const malformed = fakeNamespace(() => ({ status: 'ok', nextCursor: null }));
    expect(await storeOn(malformed.namespace).listStudies(5)).toEqual({ status: 'unavailable' });

    const refused = fakeNamespace(() => ({ status: 'too-large', count: 7, maximum: 5 }));
    expect(await storeOn(refused.namespace).listStudies(5)).toEqual({ status: 'too-large', count: 7, maximum: 5 });

    const thrown = fakeNamespace(() => {
      throw new Error('RPC reply exceeded the size limit');
    });
    expect(await storeOn(thrown.namespace).listStudies(5)).toEqual({ status: 'unavailable' });
  });

  it('ST-08: the assembled bytes stop at the Worker ceiling, and later pages ask only for what is left', async () => {
    const big = { id: 'big', padding: 'p'.repeat(3 * 1024 * 1024) } as unknown as StudyListItem;
    let served = 0;
    const endless = fakeNamespace(() => {
      served += 1;
      return { status: 'ok', items: [big], nextCursor: `${served}:big`, count: 900 };
    });
    expect(await storeOn(endless.namespace).listStudies(1_000)).toEqual({ status: 'too-large', count: 900, maximum: 1_000 });
    const budgets = (endless.calls as Array<{ page: { maxPageBytes: number } }>).map((call) => call.page.maxPageBytes);
    expect(served).toBe(Math.floor(MAX_LIST_STUDIES_BYTES / (3 * 1024 * 1024)) + 1);
    expect(budgets[0]).toBe(LIST_STUDIES_PAGE_BYTES);
    expect(budgets.every((budget, index) => index === 0 || budget <= budgets[index - 1])).toBe(true);
    expect(budgets.at(-1)).toBeLessThan(LIST_STUDIES_PAGE_BYTES);
  });
});
