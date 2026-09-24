// @vitest-environment node
// OPS-04 "Inventory old storage": scripts/cloudflare/inventory-redis.mjs against a
// runner-owned disposable redis-server seeded through the application's own store
// and kv.ts operations (never an inherited or shared Redis).
//
// The production executor (Upstash REST /pipeline) runs unmodified; only its fetch
// is replaced by a local shim that checks the REST request shape and forwards each
// command to the disposable Redis over node-redis (RESP2, the reply shapes Upstash
// REST returns). Claims covered: counts per family, schema/shape distributions,
// pending operations, orphaned and expired references, the importer's analysis
// mapping, that only read commands reach the server and no data changes, bounded
// scans report truncation, and that no body, transcript, identifier, link code,
// session identifier or credential appears in any output.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  ANALYSIS_CLAIM_LEASE_MS as KV_ANALYSIS_CLAIM_LEASE_MS,
  attachInterviewAnalysis,
  claimInterviewAnalysis,
  persistCompletedInterviewP1,
  recordInterviewAnalysisFailure,
} from '@/lib/kv';
import { beginCreateIdempotencyForHash, STANDALONE_SCOPE } from '@/lib/createIdempotency';
import { isValidUpstashUrl as kvClientIsValidUpstashUrl, storageIdFromRedisUrl } from '@/lib/kvClient';
import type { PersistRatePlanRow } from '@/lib/rateLimit';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import type { PersistCompletedInterviewInput, WorkspaceStorePort } from '@/lib/storage/types';
import type { StoredAggregateSynthesis, StoredInterview, StoredStudy, StudyConfig } from '@/types';
import { startDisposableRedis, type DisposableRedis } from '../helpers/disposableRedis';
import {
  ANALYSIS_CLAIM_LEASE_MS,
  createUpstashRestExecutor,
  EXIT_REFUSED,
  InventoryError,
  isValidUpstashUrl,
  PROJECTION_SCRIPT,
  runInventory,
} from '../../scripts/cloudflare/inventory-redis.mjs';

process.env.DEPLOYMENT_MODE = 'standalone';
delete process.env.DEPLOYMENT_TARGET;
delete process.env.PLATFORM_KEY_PREFIX;
delete process.env.REDIS_URL;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.PLATFORM_KV_REST_API_URL;
delete process.env.PLATFORM_KV_REST_API_TOKEN;

const CLI = path.join(process.cwd(), 'scripts', 'cloudflare', 'inventory-redis.mjs');
const REST_URL = 'https://inventory-fixture.upstash.io';
const REST_TOKEN = `synthetic-inventory-token-${randomBytes(12).toString('hex')}`;
const MODEL = 'gemini-3.7-flash';
const DAY_SECONDS = 86_400;

/** Every string that must never appear in any output of the tool. */
const secrets = new Set<string>([REST_TOKEN, 'inventory-fixture']);
const BODY_MARKERS = {
  studyName: 'BODYMARK-study-name-4be1',
  question: 'BODYMARK-research-question-91c2',
  consent: 'BODYMARK-consent-text-77aa',
  transcript: 'TRANSCRIPTMARK-participant-words-5d0e',
  profile: 'PROFILEMARK-raw-context-c3f9',
  synthesis: 'SYNTHMARK-bottom-line-2a6b',
  aggregate: 'AGGMARK-bottom-line-e8d4',
  foreign: 'FOREIGNMARK-other-app-value-19fe',
};
for (const marker of Object.values(BODY_MARKERS)) secrets.add(marker);

// Mirrors @upstash/redis parseResponse so legacy bare-JSON records read back as in
// production (same wrapper as tests/integration/workspaceStore.redis.contract.test.ts).
function parseRecursive(value: unknown): unknown {
  const parsed = Array.isArray(value)
    ? value.map((item) => {
      try {
        return parseRecursive(item);
      } catch {
        return item;
      }
    })
    : JSON.parse(value as string);
  if (typeof parsed === 'number' && parsed.toString() !== value) return value;
  return parsed;
}

function withUpstashReplies(inner: RedisPort): RedisPort {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => Promise.resolve(member.apply(target, args)).then((value) => {
        try {
          return parseRecursive(value);
        } catch {
          return value;
        }
      });
    },
  });
}

type RawClient = ReturnType<typeof createClient>;

let owned: DisposableRedis | undefined;
let port: RedisPort;
let store: WorkspaceStorePort;
let raw: RawClient;

function hex64(): string {
  return randomBytes(32).toString('hex');
}

function studyConfig(id: string, createdAt: number): StudyConfig {
  return {
    id,
    name: `${BODY_MARKERS.studyName} ${id.slice(0, 4)}`,
    description: 'Synthetic inventory fixture.',
    researchQuestion: BODY_MARKERS.question,
    coreQuestions: ['What happened first?'],
    topicAreas: ['Inventory'],
    profileSchema: [{ id: 'role', label: 'Role', extractionHint: 'Their role', required: false }],
    aiBehavior: 'standard',
    aiProvider: 'gemini',
    aiModel: MODEL,
    consentText: BODY_MARKERS.consent,
    linkExpiration: 'never',
    createdAt,
  };
}

function candidateStudy(createdAt = Date.now()): StoredStudy {
  const id = randomUUID();
  return { id, config: studyConfig(id, createdAt), createdAt, updatedAt: createdAt, interviewCount: 0, isLocked: false, revision: 1 };
}

async function createStudy(): Promise<StoredStudy> {
  const digest = hex64();
  secrets.add(digest);
  const outcome = await store.createStudy({ idempotencyKeyDigest: digest, fingerprint: hex64(), candidate: candidateStudy() });
  if (outcome.status !== 'created') throw new Error(`createStudy: ${outcome.status}`);
  secrets.add(outcome.study.id);
  return outcome.study;
}

async function currentStudy(id: string): Promise<StoredStudy> {
  const loaded = await store.getStudy(id);
  if (loaded.status !== 'found') throw new Error(`getStudy: ${loaded.status}`);
  return loaded.study;
}

async function createLink(study: StoredStudy, expiresAt: number | null = null): Promise<string> {
  const created = await store.createParticipantLink({ studyId: study.id, studyRevision: study.revision, expiresAt, now: Date.now() });
  if (created.status !== 'created') throw new Error(`createParticipantLink: ${created.status}`);
  secrets.add(created.code);
  secrets.add(created.link.id);
  return created.link.id;
}

const windowStart = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
const SAVE_ROW: PersistRatePlanRow = { key: `interview-rate:${hex64()}:${windowStart}`, maximum: 50, windowSeconds: DAY_SECONDS, windowStart };

function interviewFor(study: StoredStudy, sessionId: string, linkId: string | null): StoredInterview {
  const now = Date.now();
  const id = `session-${sessionId}`;
  secrets.add(sessionId);
  secrets.add(id);
  return {
    id,
    studyId: study.id,
    studyName: study.config.name,
    participantProfile: { id, fields: [], rawContext: BODY_MARKERS.profile, timestamp: now },
    transcript: [
      { id: 'm-1', role: 'ai', content: 'Welcome to the study.', timestamp: now },
      { id: 'm-2', role: 'user', content: BODY_MARKERS.transcript, timestamp: now + 1 },
    ],
    synthesis: null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: now,
    completedAt: now + 2,
    status: 'completed',
    studyRevision: study.revision,
    consentHash: 'c'.repeat(64),
    consentAcceptedAt: now,
    conductedByProvider: 'gemini',
    conductedByModel: MODEL,
    analysis: { status: 'pending', attempts: 0, lastAttemptAt: now },
    ...(linkId ? { participantLinkId: linkId } : {}),
  };
}

function completion(study: StoredStudy, interview: StoredInterview, sessionId: string, linkId: string | null): PersistCompletedInterviewInput {
  return {
    interview,
    fingerprint: hex64(),
    expectedStudyRevision: study.revision,
    allowDisabledLinks: false,
    ratePlan: [SAVE_ROW],
    identity: { participantSessionId: sessionId, linkId },
    now: Date.now(),
  };
}

async function persistInterview(studyId: string, linkId: string | null): Promise<StoredInterview> {
  const study = await currentStudy(studyId);
  const sessionId = randomUUID();
  const interview = interviewFor(study, sessionId, linkId);
  const outcome = await store.persistCompletedInterview(completion(study, interview, sessionId, linkId));
  if (outcome.status !== 'created') throw new Error(`persistCompletedInterview: ${outcome.status}`);
  return interview;
}

async function claim(interviewId: string, at = Date.now()): Promise<string> {
  const claimed = await claimInterviewAnalysis(interviewId, port, at);
  if (claimed.status !== 'claimed') throw new Error(`claimInterviewAnalysis: ${claimed.status}`);
  return claimed.claimId;
}

function aggregateFor(study: StoredStudy, interviewIds: string[]): StoredAggregateSynthesis {
  const now = Date.now();
  return {
    studyId: study.id,
    studyRevision: study.revision,
    interviewIds,
    interviewCount: interviewIds.length,
    aiProvider: 'gemini',
    aiModel: MODEL,
    commonThemes: [{ theme: 'Routine', frequency: interviewIds.length, quoteRefs: [] }],
    divergentViews: [],
    keyFindings: ['Synthetic finding'],
    researchImplications: ['Synthetic implication'],
    bottomLine: BODY_MARKERS.aggregate,
    generatedAt: now,
    savedAt: now,
  };
}

function legacySampleInterview(id: string, studyId: string, withSynthesis: boolean): StoredInterview {
  const now = Date.now();
  secrets.add(id);
  return {
    id,
    studyId,
    studyName: 'Sample study',
    participantProfile: { id, fields: [], rawContext: BODY_MARKERS.profile, timestamp: now },
    transcript: [{ id: 'm-1', role: 'user', content: BODY_MARKERS.transcript, timestamp: now }],
    synthesis: withSynthesis
      ? {
        statedPreferences: [],
        revealedPreferences: [],
        themes: [],
        contradictions: [],
        keyInsights: [],
        bottomLine: BODY_MARKERS.synthesis,
      }
      : null,
    behaviorData: { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] },
    createdAt: now,
    completedAt: now,
    status: 'completed',
  };
}

/**
 * Upstash REST /pipeline served by the disposable Redis. Records every command it
 * forwards, every protocol violation (wrong URL, method, redirect mode, token or
 * body shape) and, when asked, every reply body exactly as it goes back on the
 * wire; an override answers a command with an Upstash-style error instead, and
 * `fail` answers a whole request with an HTTP error.
 */
function upstashShim(options: {
  log: string[][];
  violations: string[];
  override?: (command: string[]) => { error: string } | null;
  replies?: string[];
  fail?: (commands: string[][]) => number | null;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${REST_URL}/pipeline`) options.violations.push('url');
    if (init?.method !== 'POST') options.violations.push('method');
    if (init?.redirect !== 'error') options.violations.push('redirect');
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${REST_TOKEN}`) {
      return new Response(JSON.stringify({ error: 'WRONGPASS invalid or missing auth token' }), { status: 401 });
    }
    const commands = JSON.parse(String(init?.body)) as unknown;
    if (!Array.isArray(commands) || !commands.every((c) => Array.isArray(c) && c.every((p) => typeof p === 'string'))) {
      options.violations.push('body');
      return new Response(JSON.stringify({ error: 'ERR bad body' }), { status: 400 });
    }
    const status = options.fail?.(commands as string[][]);
    if (status) return new Response(JSON.stringify({ error: 'synthetic upstream failure' }), { status });
    const results: Array<{ result: unknown } | { error: string }> = [];
    for (const command of commands as string[][]) {
      options.log.push(command);
      const override = options.override?.(command);
      if (override) {
        results.push(override);
        continue;
      }
      try {
        results.push({ result: await raw.sendCommand(command) });
      } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const body = JSON.stringify(results);
    options.replies?.push(body);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function executorFor(shim: typeof fetch, token = REST_TOKEN) {
  return createUpstashRestExecutor({ url: REST_URL, token, fetchImpl: shim });
}

/** Digest of every key, type, value and expiry class (test-only full read). */
async function snapshot(): Promise<string> {
  const keys = ((await raw.sendCommand(['KEYS', '*'])) as string[]).sort();
  const rows: unknown[] = [];
  for (const key of keys) {
    const type = (await raw.sendCommand(['TYPE', key])) as string;
    let value: unknown = null;
    if (type === 'string') value = await raw.sendCommand(['GET', key]);
    if (type === 'set') value = ((await raw.sendCommand(['SMEMBERS', key])) as string[]).sort();
    if (type === 'zset') value = await raw.sendCommand(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
    if (type === 'hash') value = await raw.sendCommand(['HGETALL', key]);
    const ttl = (await raw.sendCommand(['PTTL', key])) as number;
    rows.push([key, type, value, ttl >= 0 ? 'expiring' : ttl]);
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function commandStats(): Promise<Map<string, number>> {
  const info = (await raw.sendCommand(['INFO', 'commandstats'])) as string;
  const stats = new Map<string, number>();
  for (const line of info.split(/\r?\n/)) {
    const match = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
    if (match) stats.set(match[1], Number(match[2]));
  }
  return stats;
}

function expectNoSecrets(text: string): void {
  for (const secret of secrets) {
    expect(text.includes(secret), `output contains a seeded secret or identifier (${secret.slice(0, 6)}…)`).toBe(false);
  }
}

const seeded = {
  expiringLinkId: '',
  studyA: '',
  runningClaimedAt: 0,
  stuckClaimedAt: 0,
};

beforeAll(async () => {
  owned = await startDisposableRedis();
  if (!owned.url.startsWith('redis://127.0.0.1:')) throw new Error('refusing a non-loopback Redis');
  port = withUpstashReplies(owned.adapter());
  store = createRedisWorkspaceStore(port, { researcherId: null });
  raw = createClient({ url: owned.url, RESP: 2 });
  await raw.connect();

  // Study A: links (open, short-lived, revoked), consent, five completed interviews
  // across every analysis state, an aggregate, and one completion stopped after P1.
  const a = await createStudy();
  seeded.studyA = a.id;
  const linkA = await createLink(a);
  seeded.expiringLinkId = await createLink(a, Date.now() + 1_000);
  const revokedLink = await createLink(a);
  expect((await store.revokeParticipantLink({ studyId: a.id, linkId: revokedLink, now: Date.now() })).status).toBe('revoked');
  const consentSession = randomUUID();
  secrets.add(consentSession);
  expect((await store.recordConsent({
    participantSessionId: consentSession, studyId: a.id, studyRevision: a.revision, consentText: a.config.consentText, now: Date.now(),
  })).status).toBe('accepted');

  const complete = await persistInterview(a.id, linkA);
  const running = await persistInterview(a.id, linkA);
  const stuck = await persistInterview(a.id, linkA);
  const failed = await persistInterview(a.id, linkA);
  await persistInterview(a.id, linkA);
  const claimId = await claim(complete.id);
  expect((await attachInterviewAnalysis({
    interviewId: complete.id,
    claimId,
    synthesis: legacySampleInterview('unused', a.id, true).synthesis!,
    provenance: { aiProvider: 'gemini', aiModel: MODEL, requestedAiModel: MODEL },
    studyRevision: a.revision,
  }, port)).status).toBe('written');
  seeded.runningClaimedAt = Date.now();
  await claim(running.id, seeded.runningClaimedAt);
  seeded.stuckClaimedAt = Date.now() - 10 * 60_000;
  await claim(stuck.id, seeded.stuckClaimedAt);
  expect((await recordInterviewAnalysisFailure(failed.id, await claim(failed.id), 'provider', port)).status).toBe('written');
  expect(await store.saveAggregate(aggregateFor(await currentStudy(a.id), [complete.id]))).toBe('saved');

  const unfinishedSession = randomUUID();
  const aNow = await currentStudy(a.id);
  const unfinished = interviewFor(aNow, unfinishedSession, linkA);
  const p1 = await persistCompletedInterviewP1(unfinished, hex64(), {
    expectedStudyRevision: aNow.revision,
    rateLimits: [SAVE_ROW],
    identity: { participantSessionId: unfinishedSession, linkId: linkA },
  }, port);
  expect(p1.status).toBe('started');

  // Study B: created, linked, deleted while empty; its link stays, and an aggregate
  // saved afterwards (a recorded Redis residual) points at the missing study.
  const b = await createStudy();
  await createLink(b);
  expect((await store.deleteStudy({ studyId: b.id, now: Date.now() })).status).toBe('deleted');
  expect(await store.saveAggregate(aggregateFor(b, [`session-${randomUUID()}`]))).toBe('saved');

  // Study D: a link, one interview, a config edit (the link's revision is now
  // superseded), then a refused populated delete that leaves its in-flight guard.
  const d = await createStudy();
  const linkD = await createLink(d);
  await persistInterview(d.id, linkD);
  const dNow = await currentStudy(d.id);
  expect((await store.replaceStudyConfig({
    studyId: d.id, expectedRevision: dNow.revision, config: { ...dNow.config, description: 'Edited.' }, now: Date.now(),
  })).status).toBe('updated');
  expect((await store.deleteStudy({ studyId: d.id, now: Date.now() })).status).toBe('conflict');

  // A create whose idempotency mapping was reserved but never completed.
  const pendingHash = hex64();
  secrets.add(pendingHash);
  const pending = await beginCreateIdempotencyForHash({
    client: port, mode: 'standalone', researcherId: STANDALONE_SCOPE, idempotencyHash: pendingHash,
    fingerprint: hex64(), mintStudy: () => candidateStudy(),
  });
  expect(pending.status).toBe('started');

  // Legacy sample workspace (bare JSON): one study with a legacy-complete interview,
  // and one interview whose study no longer exists.
  const sample = { ...candidateStudy(), interviewCount: 1, isLocked: true };
  secrets.add(sample.id);
  const retiredStudyId = randomUUID();
  secrets.add(retiredStudyId);
  const seededSample = await store.seedSampleWorkspace({
    studies: [sample],
    interviews: [
      legacySampleInterview(`sample-${randomUUID()}`, sample.id, true),
      legacySampleInterview(`sample-${randomUUID()}`, retiredStudyId, false),
    ],
    now: Date.now(),
  });
  expect(seededSample).toEqual({ status: 'seeded', studiesSeeded: 1, interviewsSeeded: 2 });

  // A participant admission counter keyed by a session identifier.
  const admissionSession = randomUUID();
  secrets.add(admissionSession);
  expect((await store.admitParticipantRequest({
    operation: 'interview',
    counters: [{ key: `rate-limit:interview:session:3600:${admissionSession}`, maximum: 5, windowSeconds: 3_600 }],
    now: Date.now(),
  })).status).toBe('admitted');

  // A key another application wrote into the same database.
  await raw.sendCommand(['SET', `other-app:${BODY_MARKERS.foreign}`, BODY_MARKERS.foreign]);

  // Let the short-lived link expire so its index member dangles.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (Number(await raw.sendCommand(['EXISTS', `participant-link:${seeded.expiringLinkId}`])) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(async () => {
  await raw?.quit().catch(() => {});
  await owned?.close();
});

describe('OPS-04: read-only Redis inventory (scripts/cloudflare/inventory-redis.mjs)', () => {
  it('reports counts, shapes, pending operations and orphans without changing data or printing secrets', async () => {
    expect(await raw.sendCommand(['EXISTS', `participant-link:${seeded.expiringLinkId}`])).toBe(0);
    const before = await snapshot();
    const log: string[][] = [];
    const violations: string[] = [];
    const executor = executorFor(upstashShim({ log, violations }));
    const progress: string[] = [];
    await raw.sendCommand(['CONFIG', 'RESETSTAT']);

    const report = await runInventory(executor, { scanCount: 10, progress: (line: string) => progress.push(line) });

    const stats = await commandStats();
    const after = await snapshot();
    expect(violations).toEqual([]);
    expect(after).toBe(before);

    // Only read commands reached the server, including those run inside the script.
    const allowed = new Set([
      'ping', 'dbsize', 'scan', 'type', 'pttl', 'strlen', 'scard', 'zcard', 'hlen', 'llen', 'memory|usage',
      'eval_ro', 'get', 'exists', 'sismember', 'smembers', 'zrange', 'info', 'config|resetstat',
    ]);
    expect([...stats.keys()].filter((name) => !allowed.has(name))).toEqual([]);
    expect(stats.get('eval_ro')).toBeGreaterThan(0);
    expect(new Set(log.map((command) => command[0]))).toEqual(
      new Set(['PING', 'DBSIZE', 'SCAN', 'TYPE', 'PTTL', 'STRLEN', 'SCARD', 'ZCARD', 'MEMORY', 'EVAL_RO']),
    );

    expect(report.complete).toBe(true);
    expect(report.incompleteReasons).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.scan.finished).toBe(true);
    expect(report.scan.truncated).toBeNull();
    expect(report.capabilities).toMatchObject({ memoryUsage: true, fieldProjection: true, unprojectedKeys: 0 });
    expect(report.target.storageId).toBe(storageIdFromRedisUrl(REST_URL));
    expect(report.summary.totalKeys).toBe(report.scan.dbsizeAfter);
    expect(report.warnings).toEqual(['unrecognized-keys-present']);

    const count = (family: string) => report.families[family].count;
    expect({
      studies: count('studies'),
      interviews: count('interviews'),
      interviewFingerprints: count('interviewFingerprints'),
      interviewPersistGuards: count('interviewPersistGuards'),
      studyInterviewIndexes: count('studyInterviewIndexes'),
      studyPersistingSets: count('studyPersistingSets'),
      allStudiesIndex: count('allStudiesIndex'),
      allInterviewsIndex: count('allInterviewsIndex'),
      aggregates: count('aggregates'),
      operationReceipts: count('operationReceipts'),
      mutationGuards: count('mutationGuards'),
      participantLinks: count('participantLinks'),
      participantLinkIndexes: count('participantLinkIndexes'),
      consents: count('consents'),
      createIdempotency: count('createIdempotency'),
      createIdempotencyIndexes: count('createIdempotencyIndexes'),
      participantRateLimits: count('participantRateLimits'),
      saveRateLimits: count('saveRateLimits'),
      unrecognized: count('unrecognized'),
    }).toEqual({
      studies: 3, // A, D, legacy sample (B deleted)
      interviews: 9, // A ×5 + A's unfinished P1 + D ×1 + legacy ×2
      interviewFingerprints: 7, // every completion path; legacy seeds have none
      interviewPersistGuards: 1,
      studyInterviewIndexes: 4, // A, D, sample, retired study
      studyPersistingSets: 1,
      allStudiesIndex: 1,
      allInterviewsIndex: 1,
      aggregates: 2,
      operationReceipts: 4, // create A, B, D; delete B
      mutationGuards: 2, // A created, D's refused delete in flight (B's delete removed its own)
      participantLinks: 4, // open, revoked, B's, D's (the short-lived one expired)
      participantLinkIndexes: 1,
      consents: 1,
      createIdempotency: 4, // A, B, D created; one pending
      createIdempotencyIndexes: 1,
      participantRateLimits: 1,
      saveRateLimits: 1,
      unrecognized: 1,
    });
    expect(report.unrecognizedPrefixes).toEqual({ 'other-app:': 1 });
    expect(report.families.interviews.bytes.max).toBeGreaterThan(0);
    expect(report.families.interviews.memoryUsage.total).toBeGreaterThan(0);
    expect(report.families.consents.ttl).toEqual({ persistent: 0, expiring: 1 });

    const { studies, interviews, participantLinks, aggregates, consents, createIdempotency, mutationGuards } = report.records;
    expect(studies).toMatchObject({
      projected: 3,
      encoding: { prefixed: 2, bare: 1, undecodable: 0 },
      identityMismatch: 0,
      revision: { present: 3, missing: 0, max: 2 },
      notInAllStudies: 0,
      cachedCountMismatch: 0,
      withAggregate: 1,
      withMutationGuard: 2,
      withUnfinishedPersists: 1,
    });
    expect(interviews).toMatchObject({
      projected: 9,
      encoding: { prefixed: 7, bare: 2, undecodable: 0 },
      status: { completed: 9, in_progress: 0, other: 0 },
      study: { present: 8, missing: 1, undecodable: 0, 'invalid-id': 0 },
      notInStudyIndex: 1,
      notInAllInterviews: 1,
      withoutFingerprint: 2,
      withPersistGuard: 1,
      shape: { withSynthesis: 2, withConductedBy: 7, withStudyRevision: 7, withConsent: 7, withParticipantLink: 7 },
    });
    expect(interviews.analysis).toMatchObject({
      member: { absent: 2, pending: 3, running: 2, complete: 1, failed: 1, other: 0 },
      effective: { pending: 4, running: 2, complete: 2, failed: 1, other: 0 },
      runningLeaseActive: 1,
      runningLeaseExpired: 1,
      pendingAfterAttempt: 0,
      failureKind: { provider: 1 },
      importMapping: { notScheduled: 4, complete: 2, failedTerminal: 1, recoveryRequired: 2, unmapped: 0 },
    });
    expect(participantLinks).toMatchObject({
      projected: 4,
      encoding: { prefixed: 0, bare: 4, undecodable: 0 },
      version: { v1: 4 },
      state: { active: 3, expired: 0, revoked: 1 },
      owner: { none: 4, researcher: 0 },
      study: { present: 3, missing: 1 },
      revisionStale: 1,
      notIndexed: 0,
    });
    expect(aggregates).toMatchObject({ projected: 2, encoding: { prefixed: 2 }, study: { present: 1, missing: 1 }, revisionStale: 0 });
    expect(consents).toMatchObject({ projected: 1, encoding: { bare: 1 }, version: { v1: 1 }, study: { present: 1 } });
    expect(createIdempotency).toMatchObject({
      projected: 4, state: { pending: 1, created: 3, deleted: 0 }, study: { present: 2, missing: 2 }, createdWithoutStudy: 1,
    });
    expect(mutationGuards).toMatchObject({
      projected: 2, kind: { create: 1, delete: 1 }, state: { 'in-flight': 1, created: 1, deleted: 0 }, study: { present: 2 },
    });
    expect(report.records.operationReceipts).toMatchObject({ kind: { create: 3, delete: 1 }, resolution: { created: 3, deleted: 1 } });
    expect(report.records.persistGuards).toMatchObject({ projected: 1, version: { v2: 1 }, interviewMissing: 0, notInStudyPersistingSet: 0 });
    expect(report.records.fingerprints).toMatchObject({ projected: 7, encoding: { prefixed: 7 }, interviewMissing: 0 });

    expect(report.collections).toMatchObject({
      allStudies: { keys: 1, members: 3, missingTargets: 0 },
      allInterviews: { keys: 1, members: 8, missingTargets: 0 },
      studyInterviewIndexes: { keys: 4, members: 8, missingTargets: 0, missingTargetsAlsoInAllInterviews: 0, study: { present: 3, missing: 1 } },
      studyPersistingSets: { keys: 1, members: 1, missingTargets: 0 },
      participantLinkIndexes: { keys: 1, members: 5, missingTargets: 1 },
      createIdempotencyIndexes: { keys: 1, members: 4, missingTargets: 0 },
    });
    expect(report.pendingOperations).toEqual({
      studyMutationsInFlight: 1,
      interviewPersistsUnfinished: 1,
      studyPersistingMembers: 1,
      createIdempotencyPending: 1,
      analysisRunning: 1,
      analysisRunningLeaseExpired: 1,
      analysisPendingAfterAttempt: 0,
    });
    expect(report.orphans).toEqual({
      interviewsWithoutStudy: 1,
      linksWithoutStudy: 1,
      aggregatesWithoutStudy: 1,
      consentsWithoutStudy: 0,
      createdIdempotencyWithoutStudy: 1,
      persistGuardsWithoutInterview: 0,
      fingerprintsWithoutInterview: 0,
      studyInterviewIndexesWithoutStudy: 1,
      studyInterviewIndexMembersWithoutInterview: 0,
      studyPersistingMembersWithoutGuard: 0,
      allStudiesMembersWithoutStudy: 0,
      allInterviewsMembersWithoutInterview: 0,
      invalidStudyReferences: 0,
    });
    expect(report.expiredReferences).toMatchObject({
      linksExpiredStillStored: 0,
      linksRevoked: 1,
      linksForSupersededStudyRevision: 1,
      linkIndexMembersWithoutLink: 1,
    });
    // Each operation and orphan once: D's in-flight delete, the unfinished save
    // (its guard and its study-persisting member are one save), the pending
    // create and the two running analyses; B's link, aggregate and create
    // mapping and the retired study's interview (its study index is that
    // interview's entry, not another orphan).
    expect(report.summary).toMatchObject({
      hasResearchData: true,
      pendingOperations: 5,
      interviewsAwaitingFirstAnalysis: 4,
      orphanedReferences: 4,
      unrecognizedKeys: 1,
    });

    expectNoSecrets(JSON.stringify(report));
    expectNoSecrets(progress.join('\n'));
  });

  it('keeps record bodies on the server: no reply on the wire carries a body marker', async () => {
    const replies: string[] = [];
    const violations: string[] = [];
    const report = await runInventory(executorFor(upstashShim({ log: [], violations, replies })), { scanCount: 10 });
    expect(violations).toEqual([]);
    expect(report.capabilities.fieldProjection).toBe(true);
    // The projection really ran over the bodies that carry the markers.
    expect(replies.some((body) => body.includes('\\"enc\\":\\"prefixed\\"'))).toBe(true);
    const wire = replies.join('\n');
    // The foreign marker is part of a key name, which SCAN returns by design.
    for (const [name, marker] of Object.entries(BODY_MARKERS).filter(([name]) => name !== 'foreign')) {
      expect(wire.includes(marker), `wire reply carries ${name}`).toBe(false);
    }
  });

  it('counts a running analysis as expired exactly at the kv.ts lease boundary', async () => {
    expect(ANALYSIS_CLAIM_LEASE_MS).toBe(KV_ANALYSIS_CLAIM_LEASE_MS);
    const at = async (nowMs: number) => (await runInventory(
      executorFor(upstashShim({ log: [], violations: [] })),
      { scanCount: 50, clock: () => nowMs },
    )).records.interviews.analysis;
    // kv.ts: a claim is live while now - claimedAt < lease.
    const justInside = await at(seeded.runningClaimedAt + ANALYSIS_CLAIM_LEASE_MS - 1);
    expect(justInside).toMatchObject({ runningLeaseActive: 1, runningLeaseExpired: 1 });
    const atBoundary = await at(seeded.runningClaimedAt + ANALYSIS_CLAIM_LEASE_MS);
    expect(atBoundary).toMatchObject({ runningLeaseActive: 0, runningLeaseExpired: 2 });
    const beforeStuckExpired = await at(seeded.stuckClaimedAt + ANALYSIS_CLAIM_LEASE_MS - 1);
    expect(beforeStuckExpired).toMatchObject({ runningLeaseActive: 2, runningLeaseExpired: 0 });
    for (const analysis of [justInside, atBoundary, beforeStuckExpired]) {
      expect(analysis.importMapping.recoveryRequired).toBe(2);
    }
  });

  it('counts a missing interview listed in both all-interviews and its study index as one orphan', async () => {
    const ghost = `session-${randomUUID()}`;
    secrets.add(ghost);
    const index = `study-interviews:${seeded.studyA}`;
    await raw.sendCommand(['SADD', 'all-interviews', ghost]);
    await raw.sendCommand(['SADD', index, ghost]);
    try {
      const report = await runInventory(executorFor(upstashShim({ log: [], violations: [] })), { scanCount: 50 });
      expect(report.collections.allInterviews).toMatchObject({ missingTargets: 1, skippedOverBound: 0 });
      expect(report.collections.studyInterviewIndexes).toMatchObject({ missingTargets: 1, missingTargetsAlsoInAllInterviews: 1 });
      expect(report.orphans).toMatchObject({ allInterviewsMembersWithoutInterview: 1, studyInterviewIndexMembersWithoutInterview: 1 });
      expect(report.summary.orphanedReferences).toBe(5);
      expect(report.summary.pendingOperations).toBe(5);
      expectNoSecrets(JSON.stringify(report));
    } finally {
      await raw.sendCommand(['SREM', 'all-interviews', ghost]);
      await raw.sendCommand(['SREM', index, ghost]);
    }
  });

  it('reports a request failure mid-scan or a command error as incomplete, never as a complete report', async () => {
    let scans = 0;
    const interrupted = await runInventory(executorFor(upstashShim({
      log: [],
      violations: [],
      fail: (commands) => (commands[0][0] === 'SCAN' && ++scans === 2 ? 502 : null),
    })), { scanCount: 10 });
    expect(interrupted.complete).toBe(false);
    expect(interrupted.scan.finished).toBe(false);
    expect(interrupted.incompleteReasons).toEqual(['scan-interrupted', 'command-errors']);
    expect(interrupted.errors).toEqual([{ phase: 'transport', errorClass: 'http-502', count: 1 }]);

    const commandErrors = await runInventory(executorFor(upstashShim({
      log: [],
      violations: [],
      override: (command) => (command[0] === 'PTTL' ? { error: 'ERR synthetic failure for key interview:x' } : null),
    })), { scanCount: 50 });
    expect(commandErrors.scan.finished).toBe(true);
    expect(commandErrors.complete).toBe(false);
    expect(commandErrors.incompleteReasons).toEqual(['command-errors']);
    expect(commandErrors.errors).toEqual([{ phase: 'ttl', errorClass: 'redis-error', count: commandErrors.summary.totalKeys }]);
    expect(JSON.stringify(commandErrors)).not.toContain('interview:x');
  });

  it('reports a field-projection or MEMORY refusal as incomplete and still counts every key', async () => {
    const log: string[][] = [];
    const violations: string[] = [];
    const executor = executorFor(upstashShim({
      log,
      violations,
      override: (command) => (command[0] === 'EVAL_RO' || command[0] === 'MEMORY'
        ? { error: `ERR unknown command '${command[0]}', with args beginning with: '${command[2] ?? ''}'` }
        : null),
    }));

    const report = await runInventory(executor, { scanCount: 50 });

    expect(violations).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons).toEqual(['field-projection-unavailable', 'records-not-projected']);
    expect(report.capabilities).toMatchObject({ memoryUsage: false, fieldProjection: false, fieldProjectionError: 'unsupported-command' });
    expect(report.capabilities.unprojectedKeys).toBe(report.capabilities.projectableKeys);
    expect(report.families.studies.count).toBe(3);
    expect(report.families.interviews.count).toBe(9);
    expect(report.families.studies).not.toHaveProperty('memoryUsage');
    expect(report.records.interviews.projected).toBe(0);
    const text = JSON.stringify(report);
    expect(text).not.toContain('with args');
    expectNoSecrets(text);
  });

  it('bounds the scan by keys and by time and reports the truncation', async () => {
    const byKeys = await runInventory(executorFor(upstashShim({ log: [], violations: [] })), { maxKeys: 5, scanCount: 10 });
    expect(byKeys.complete).toBe(false);
    expect(byKeys.incompleteReasons).toEqual(['key-budget']);
    expect(byKeys.scan).toMatchObject({ finished: false, truncated: 'key-budget', keysSeen: 5 });

    let tick = 0;
    const clock = () => 1_800_000_000_000 + (tick++ === 0 ? 0 : 2_000);
    const byTime = await runInventory(executorFor(upstashShim({ log: [], violations: [] })), { maxSeconds: 1, clock });
    expect(byTime.complete).toBe(false);
    expect(byTime.incompleteReasons).toEqual(['time-budget']);
    expect(byTime.scan).toMatchObject({ finished: false, truncated: 'time-budget', keysSeen: 0 });
  });

  it('refuses every non-read command before any request, and a rejected token without echoing it', async () => {
    const log: string[][] = [];
    const executor = executorFor(upstashShim({ log, violations: [] }));
    for (const command of [
      ['SET', 'k', 'v'],
      ['DEL', 'study:x'],
      ['EVAL', PROJECTION_SCRIPT, '0'],
      ['EVAL_RO', "return redis.call('GET', KEYS[1])", '1', 'interview:x'],
      ['MEMORY', 'PURGE'],
      ['FLUSHDB'],
    ]) {
      await expect(executor.pipeline([['PING'], command])).rejects.toMatchObject({ errorClass: 'write-refused' });
    }
    expect(log).toEqual([]);

    const wrongToken = `wrong-${REST_TOKEN}`;
    const rejected = await runInventory(executorFor(upstashShim({ log, violations: [] }), wrongToken)).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(InventoryError);
    expect(rejected).toMatchObject({ exitCode: EXIT_REFUSED, errorClass: 'unauthorized' });
    expect(String((rejected as Error).message)).not.toContain(wrongToken);
  });

  it('validates the REST URL exactly as kvClient does, and additionally refuses userinfo', () => {
    const cases = [
      'https://inventory-fixture.upstash.io',
      'https://inventory-fixture.upstash.io/',
      'http://inventory-fixture.upstash.io',
      'https://upstash.io.example.com',
      'https://inventory-fixture.upstash.io.example.com',
      'redis://127.0.0.1:6379',
      'https://127.0.0.1',
      'not a url',
    ];
    for (const url of cases) expect(isValidUpstashUrl(url), url).toBe(kvClientIsValidUpstashUrl(url));
    for (const url of cases.filter((candidate) => !kvClientIsValidUpstashUrl(candidate))) {
      expect(() => createUpstashRestExecutor({ url, token: REST_TOKEN }), url).toThrow(/upstash\.io/);
    }
    expect(() => createUpstashRestExecutor({ url: 'https://user:pw@inventory-fixture.upstash.io', token: REST_TOKEN }))
      .toThrow(/must not carry credentials/);
    expect(createUpstashRestExecutor({ url: 'https://Inventory-Fixture.upstash.io/path', token: REST_TOKEN }).origin)
      .toBe('https://inventory-fixture.upstash.io');
  });

  describe('CLI credential intake', () => {
    const cliSecret = `cli-secret-${randomBytes(8).toString('hex')}`;
    const run = (args: string[], input: string, env: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        input,
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    it('refuses credentials in arguments without echoing them', () => {
      // Node's parseArgs error text quotes an unknown `--<text>` option in full.
      for (const args of [[`--token=${cliSecret}`], [`--${cliSecret}`], [`https://${cliSecret}.upstash.io`], ['--max-keys', cliSecret]]) {
        const result = run(args, '{}');
        expect(result.status, args.join(' ')).toBe(EXIT_REFUSED);
        expect(result.output).not.toContain(cliSecret);
      }
    });

    it('refuses a non-Upstash URL from stdin without echoing the URL or token', () => {
      const result = run([], JSON.stringify({ KV_REST_API_URL: `http://127.0.0.1:6379/${cliSecret}`, KV_REST_API_TOKEN: cliSecret }));
      expect(result.status).toBe(EXIT_REFUSED);
      expect(result.output).toContain('*.upstash.io');
      expect(result.output).not.toContain(cliSecret);
    });

    it('runs through a symlinked path (Node runs the real path of a linked script)', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'oi-inventory-link-'));
      try {
        const link = path.join(dir, 'inventory-redis.mjs');
        symlinkSync(CLI, link);
        const env = { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv;
        const help = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 20_000, env });
        expect(help.status).toBe(0);
        expect(help.stdout).toMatch(/^Usage: node scripts\/cloudflare\/inventory-redis\.mjs/);
        const refused = spawnSync(process.execPath, [link], { input: '{}', encoding: 'utf8', timeout: 20_000, env });
        expect(refused.status).toBe(EXIT_REFUSED);
        expect(refused.stdout).toContain('"errorClass":"refused"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('names unexpected stdin keys only when every one is a plain variable name', () => {
      const mixed = run([], JSON.stringify({ KV_REST_API_URL: REST_URL, KV_REST_API_TOKEN: 'x', EXTRA_NAME: 1, [`x-${cliSecret}`]: 1 }));
      expect(mixed.status).toBe(EXIT_REFUSED);
      expect(mixed.output).toContain('unexpected names');
      expect(mixed.output).not.toContain(cliSecret);
      expect(mixed.output).not.toContain('EXTRA_NAME');
      const plain = run([], JSON.stringify({ KV_REST_API_URL: REST_URL, KV_REST_API_TOKEN: 'x', EXTRA_NAME: 1 }));
      expect(plain.status).toBe(EXIT_REFUSED);
      expect(plain.output).toContain('unexpected names: EXTRA_NAME');
    });

    it('never reads credentials from the environment', () => {
      const result = run([], '{}', { KV_REST_API_URL: REST_URL, KV_REST_API_TOKEN: cliSecret });
      expect(result.status).toBe(EXIT_REFUSED);
      expect(result.output).toContain('lacks KV_REST_API_URL');
      expect(result.output).not.toContain(cliSecret);
    });
  });
});
