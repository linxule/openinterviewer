import { beforeEach, describe, expect, it } from 'vitest';
import { reset, runInDurableObject } from 'cloudflare:test';
import { createHmac } from 'node:crypto';
import { hashConsentText } from '../../src/lib/participantConsent';
import {
  analysisRequestFingerprint,
  analysisRequestKeyDigest,
  createDurableWorkspaceStore,
  LIST_INTERVIEWS_PAGE_BYTES,
  mintParticipantLinkCode,
} from '../../src/lib/storage/durableObject';
import { testEnv, workspaceStub } from './helpers';
import {
  count,
  createStudyInput,
  DAY,
  frozenInput,
  interviewRecord,
  planRow,
  sampleInterview,
  setMaintenance,
  sha256Hex,
  sql,
  T0,
} from './fixtures';

beforeEach(async () => {
  await reset();
});

const SALT = 'synthetic-rate-limit-salt-0123456789abcdef';

function realStore() {
  return createDurableWorkspaceStore({
    namespace: testEnv.WORKSPACE_STORE,
    workspaceId: testEnv.WORKSPACE_ID,
    jurisdiction: '',
    rateLimitSalt: SALT,
  });
}

type Call = { method: string; input: unknown };

/** A structural namespace double that records calls and answers or throws per method. */
function fakeNamespace(answer: (method: string, input: unknown) => unknown) {
  const calls: Call[] = [];
  const names: string[] = [];
  const jurisdictions: string[] = [];
  const makeStub = () =>
    new Proxy({}, {
      get(_target, method: string) {
        return async (input?: unknown) => {
          calls.push({ method, input });
          return answer(method, input);
        };
      },
    });
  const namespace = {
    getByName(name: string) {
      names.push(name);
      return makeStub();
    },
    jurisdiction(jurisdiction: string) {
      jurisdictions.push(jurisdiction);
      return namespace;
    },
  };
  return { namespace, calls, names, jurisdictions };
}

describe('durable client against the real object (ST-01, ST-03, ST-06)', () => {
  it('ST-01: selects the configured workspace and reaches the real object', async () => {
    const store = realStore();
    expect(store.backend).toBe('durable-object');
    expect(await store.readiness()).toEqual({ status: 'ready', maintenance: 'open' });
    const input = await createStudyInput();
    expect(await store.createStudy(input)).toEqual({ status: 'created', study: input.candidate, replayed: false });
    expect(await store.getStudy(input.candidate.id)).toEqual({ status: 'found', study: input.candidate });
    expect(await store.listStudies(10)).toEqual({ status: 'ok', items: [input.candidate] });
  });

  it('ST-03: a link code is returned once as 43 opaque characters and only its sha256 digest is stored', async () => {
    const store = realStore();
    const study = await createStudyInput();
    await store.createStudy(study);
    const created = await store.createParticipantLink({ studyId: study.candidate.id, studyRevision: 1, expiresAt: T0 + DAY, now: T0 });
    if (created.status !== 'created') throw new Error(created.status);
    expect(created.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.link.id).toBe(await sha256Hex(created.code));

    const stored = JSON.stringify(await sql(`SELECT * FROM participant_links`));
    expect(stored).toContain(created.link.id);
    expect(stored).not.toContain(created.code);

    expect(await store.resolveParticipantLinkByCode({ code: created.code, now: T0, purpose: 'exchange' }))
      .toEqual({ status: 'found', link: created.link });
    expect(await store.getParticipantLinkById({ linkId: created.link.id, now: T0 })).toEqual({ status: 'found', link: created.link });
    expect(await store.resolveParticipantLinkByCode({ code: created.code, now: T0 + DAY, purpose: 'exchange' }))
      .toEqual({ status: 'expired' });

    await setMaintenance('draining');
    expect(await store.resolveParticipantLinkByCode({ code: created.code, now: T0, purpose: 'exchange' }))
      .toEqual({ status: 'held', reason: 'maintenance' });
    expect((await store.getParticipantLinkById({ linkId: created.link.id, now: T0 })).status).toBe('found');
  });

  it('ST-03: minted codes are always 43 base64url characters', () => {
    for (let index = 0; index < 200; index += 1) expect(mintParticipantLinkCode()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('ST-03: consent is bound to the same hash participantConsent.ts computes', async () => {
    const store = realStore();
    const study = await createStudyInput();
    await store.createStudy(study);
    const consentText = 'Synthetic consent — 同意 ✓';
    const binding = { participantSessionId: crypto.randomUUID(), studyId: study.candidate.id, studyRevision: 1, consentText };
    const recorded = await store.recordConsent({ ...binding, now: T0 });
    if (recorded.status !== 'accepted') throw new Error(recorded.status);
    expect(recorded.consent.consentHash).toBe(hashConsentText(consentText));
    expect(await store.verifyConsent({ ...binding, now: T0 + 1 })).toEqual(recorded);
    expect(await store.verifyConsent({ ...binding, consentText: 'Edited consent', now: T0 + 1 })).toEqual({ status: 'mismatch' });
  });

  it('ST-06: admission scope keys are HMAC-salted before they reach storage', async () => {
    const store = realStore();
    const rawKey = 'rate-limit:greeting:client:60:study:203.0.113.7';
    const counters = [{ key: rawKey, maximum: 1, windowSeconds: 60 }];
    expect(await store.admitParticipantRequest({ operation: 'greeting', counters, now: T0 })).toEqual({ status: 'admitted' });
    expect(await store.admitParticipantRequest({ operation: 'greeting', counters, now: T0 + 1_000 }))
      .toEqual({ status: 'limited', rejectedIndex: 0, retryAfterSeconds: 59 });
    const rows = await sql<{ scope_key: string }>(`SELECT scope_key FROM budget_windows`);
    expect(rows).toEqual([{ scope_key: createHmac('sha256', SALT).update(rawKey).digest('hex') }]);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.7');
  });

  it('JOB-01: completion through the client re-verifies consent from its text and mints the initial job id', async () => {
    const store = realStore();
    const studyInput = await createStudyInput();
    await store.createStudy(studyInput);
    const study = studyInput.candidate;
    const link = await store.createParticipantLink({ studyId: study.id, studyRevision: 1, expiresAt: null, now: T0 });
    if (link.status !== 'created') throw new Error(link.status);
    const sessionId = crypto.randomUUID();
    const binding = { participantSessionId: sessionId, studyId: study.id, studyRevision: 1, consentText: study.config.consentText };
    const consent = await store.recordConsent({ ...binding, now: T0 });
    if (consent.status !== 'accepted') throw new Error(consent.status);

    const participant = {
      study, linkId: link.link.id, sessionId, consentHash: consent.consent.consentHash, consentAcceptedAt: consent.consent.acceptedAt,
    };
    const input = {
      interview: interviewRecord(participant),
      fingerprint: await sha256Hex('synthetic submission'),
      expectedStudyRevision: 1,
      allowDisabledLinks: false,
      ratePlan: [planRow(2)],
      identity: { participantSessionId: sessionId, linkId: link.link.id },
      consent: binding,
      initialAnalysis: frozenInput(study),
      now: T0,
    };

    expect(await store.persistCompletedInterview({ ...input, initialAnalysis: undefined })).toEqual({ status: 'unavailable' });
    expect(await store.persistCompletedInterview({ ...input, consent: undefined })).toEqual({ status: 'unavailable' });
    expect(await store.persistCompletedInterview({ ...input, consent: { ...binding, consentText: 'other' } }))
      .toEqual({ status: 'consent-required' });
    expect(await store.persistCompletedInterview(input)).toEqual({ status: 'created' });
    expect(await store.persistCompletedInterview(input)).toEqual({ status: 'duplicate' });
    const jobs = await sql<{ job_id: string }>(`SELECT job_id FROM analysis_jobs`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const read = await store.getInterview(input.interview.id);
    expect(read.status === 'found' && read.interview.analysis).toEqual({ status: 'pending', attempts: 0, lastAttemptAt: T0, generation: 1 });
    const listed = await store.listInterviews({ scope: 'all', maximum: 500 });
    expect(listed.status === 'ok' && listed.items.length).toBe(1);
  });

  it('ST-07: aggregate and sample operations pass through with a server-side clock', async () => {
    const store = realStore();
    const studyInput = await createStudyInput();
    await store.createStudy(studyInput);
    const aggregate = {
      studyId: studyInput.candidate.id, studyRevision: 1, interviewIds: ['session-a'], interviewCount: 1,
      aiProvider: 'openai' as const, aiModel: 'gpt-5.6-terra', commonThemes: [], divergentViews: [], keyFindings: [],
      researchImplications: [], bottomLine: 'Synthetic.', generatedAt: T0, savedAt: T0,
    };
    expect(await store.saveAggregate(aggregate)).toBe('saved');
    expect(await store.getAggregate(studyInput.candidate.id)).toEqual({ status: 'found', aggregate });
    expect(await store.clearSampleWorkspace({ studyIds: ['demo-none'], interviewIds: [] }))
      .toEqual({ status: 'cleared', studiesDeleted: 0, interviewsDeleted: 0 });
    expect(await count('aggregates')).toBe(1);
  });
});

describe('durable client collections (ST-08)', () => {
  /** Ordinary long interviews: 40 turns of about 1,000 ASCII characters (about 44 KB stored each). */
  async function insertOrdinaryInterviews(studyId: string, rows: number): Promise<number> {
    return runInDurableObject(workspaceStub(), (_instance, state) => {
      const content = 'An ordinary synthetic participant answer. '.repeat(24);
      let bytes = 0;
      for (let index = 0; index < rows; index += 1) {
        const id = `session-ordinary-${String(index).padStart(4, '0')}`;
        const transcript = Array.from({ length: 40 }, (_, turn) => ({
          id: `m${turn}`, role: turn % 2 ? 'user' : 'ai', content, timestamp: T0,
        }));
        const recordJson = JSON.stringify({ ...sampleInterview(studyId, id, T0 - index), transcript });
        bytes += new TextEncoder().encode(recordJson).byteLength;
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
      return bytes;
    });
  }

  it('ST-08: the route maximum of 1,000 ordinary interviews loads through keyset pages, newest first; one more is too-large', async () => {
    const store = realStore();
    const study = await createStudyInput();
    await store.createStudy(study);
    const bytes = await insertOrdinaryInterviews(study.candidate.id, 1_000);
    // Several RPC responses' worth: the collection can only load by paging.
    expect(bytes).toBeGreaterThan(3 * LIST_INTERVIEWS_PAGE_BYTES);

    for (const input of [
      { scope: 'study' as const, studyId: study.candidate.id, maximum: 1_000 },
      { scope: 'all' as const, maximum: 1_000 },
    ]) {
      const listed = await store.listInterviews(input);
      if (listed.status !== 'ok') throw new Error(listed.status);
      expect(listed.items).toHaveLength(1_000);
      expect(listed.items[0].id).toBe('session-ordinary-0000');
      expect(listed.items[999].id).toBe('session-ordinary-0999');
      expect(new Set(listed.items.map((item) => item.id)).size).toBe(1_000);
      expect(listed.items.every((item, index) => index === 0 || listed.items[index - 1].createdAt > item.createdAt)).toBe(true);
    }

    expect(await store.listInterviews({ scope: 'all', maximum: 999 })).toEqual({ status: 'too-large', count: 1_000, maximum: 999 });
  });

  it('ST-08: the client concatenates pages, requests each with its cursor and refuses inconsistent paging', async () => {
    const item = (id: string) => ({ id }) as unknown;
    const pages: Record<string, unknown> = {
      start: { status: 'ok', items: [item('c'), item('b')], nextCursor: '2:b', count: 3 },
      '2:b': { status: 'ok', items: [item('a')], nextCursor: null, count: 3 },
    };
    const fake = fakeNamespace((_method, input) => pages[(input as { page: { cursor: string | null } }).page.cursor ?? 'start']);
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await store.listInterviews({ scope: 'all', maximum: 3 })).toEqual({ status: 'ok', items: [item('c'), item('b'), item('a')] });
    expect(fake.calls).toEqual([
      { method: 'listInterviews', input: { scope: 'all', maximum: 3, page: { cursor: null, maxPageBytes: LIST_INTERVIEWS_PAGE_BYTES } } },
      { method: 'listInterviews', input: { scope: 'all', maximum: 3, page: { cursor: '2:b', maxPageBytes: LIST_INTERVIEWS_PAGE_BYTES } } },
    ]);

    // Rows committed between pages can push the assembled total past the maximum.
    expect(await store.listInterviews({ scope: 'all', maximum: 2 })).toEqual({ status: 'too-large', count: 3, maximum: 2 });

    const repeating = fakeNamespace(() => ({ status: 'ok', items: [item('x')], nextCursor: '1:x', count: 5 }));
    const stuck = createDurableWorkspaceStore({ namespace: repeating.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await stuck.listInterviews({ scope: 'all', maximum: 5 })).toEqual({ status: 'unavailable' });

    const malformed = fakeNamespace(() => ({ status: 'ok', nextCursor: null }));
    const broken = createDurableWorkspaceStore({ namespace: malformed.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await broken.listInterviews({ scope: 'all', maximum: 5 })).toEqual({ status: 'unavailable' });

    const refused = fakeNamespace(() => ({ status: 'too-large', count: 7, maximum: 5 }));
    const overflowing = createDurableWorkspaceStore({ namespace: refused.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await overflowing.listInterviews({ scope: 'all', maximum: 5 })).toEqual({ status: 'too-large', count: 7, maximum: 5 });
  });
});

describe('durable client transport contract (ST-01, JOB-04)', () => {
  it('ST-01: every operation uses a fresh stub selected by the configured name and jurisdiction', async () => {
    const fake = fakeNamespace(() => ({ status: 'not-found' }));
    const store = createDurableWorkspaceStore({
      namespace: fake.namespace, workspaceId: 'ws_0123456789abcdef0123456789abcdef', jurisdiction: 'eu', rateLimitSalt: SALT,
    });
    await store.getStudy('study-a');
    await store.getInterview('session-a');
    expect(fake.jurisdictions).toEqual(['eu', 'eu']);
    expect(fake.names).toEqual(['ws_0123456789abcdef0123456789abcdef', 'ws_0123456789abcdef0123456789abcdef']);
    expect(fake.calls).toEqual([
      { method: 'getStudy', input: { studyId: 'study-a' } },
      { method: 'getInterview', input: { interviewId: 'session-a' } },
    ]);
  });

  it('ST-03: malformed link codes and ids are refused locally without an RPC', async () => {
    const fake = fakeNamespace(() => ({ status: 'found' }));
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await store.resolveParticipantLinkByCode({ code: 'short', now: T0, purpose: 'exchange' })).toEqual({ status: 'not-found' });
    expect(await store.resolveParticipantLinkByCode({ code: `${'a'.repeat(42)}=`, now: T0, purpose: 'exchange' })).toEqual({ status: 'not-found' });
    expect(await store.getParticipantLinkById({ linkId: 'ABC', now: T0 })).toEqual({ status: 'not-found' });
    expect(fake.calls).toEqual([]);
  });

  it('JOB-04: retry digests are scoped by workspace, study, interview and key, and bound to the expected generation', async () => {
    const fake = fakeNamespace(() => ({ status: 'accepted', body: { status: 'pending', generation: 2, phase: 'queued', pollAfterMs: 2000 } }));
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    const key = crypto.randomUUID();
    const frozen = frozenInput((await createStudyInput()).candidate);
    const outcome = await store.acceptAnalysisRetry({
      studyId: 'study-a', interviewId: 'session-a', expectedGeneration: 1, input: frozen, now: T0, rawIdempotencyKey: key, apiVersion: 2,
    });
    expect(outcome.status).toBe('accepted');
    const sent = fake.calls[0].input as Record<string, unknown>;
    expect(fake.calls[0].method).toBe('acceptAnalysisRetry');
    expect(sent).toEqual({
      studyId: 'study-a',
      interviewId: 'session-a',
      requestKeyDigest: await sha256Hex([testEnv.WORKSPACE_ID, 'study-a', 'session-a', key].join('\u0000')),
      requestFingerprint: await sha256Hex('analysis-retry:v2\u00001'),
      expectedGeneration: 1,
      input: frozen,
      now: T0,
    });
    expect(JSON.stringify(sent)).not.toContain(key);
    expect(await analysisRequestKeyDigest({ workspaceId: testEnv.WORKSPACE_ID, studyId: 'study-a', interviewId: 'session-b', rawIdempotencyKey: key }))
      .not.toBe(sent.requestKeyDigest);
    expect(await analysisRequestFingerprint(2)).not.toBe(sent.requestFingerprint);
  });

  it('ST-01: a thrown RPC is never success: reads are unavailable and mutations ambiguous where their union allows', async () => {
    const fake = fakeNamespace(() => {
      throw new Error('synthetic transport failure');
    });
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    const unavailable = { status: 'unavailable' };
    const ambiguous = { status: 'ambiguous' };
    const study = (await createStudyInput()).candidate;

    expect(await store.readiness()).toEqual(unavailable);
    expect(await store.getStudy('s')).toEqual(unavailable);
    expect(await store.listStudies(10)).toEqual(unavailable);
    expect(await store.getInterview('i')).toEqual(unavailable);
    expect(await store.listInterviews({ scope: 'all', maximum: 10 })).toEqual(unavailable);
    expect(await store.getAggregate('s')).toEqual(unavailable);
    expect(await store.listParticipantLinks({ studyId: 's', maximum: 10, now: T0 })).toEqual(unavailable);
    expect(await store.resolveParticipantLinkByCode({ code: 'a'.repeat(43), now: T0, purpose: 'exchange' })).toEqual(unavailable);
    expect(await store.verifyConsent({ participantSessionId: 'p', studyId: 's', studyRevision: 1, consentText: 't', now: T0 })).toEqual(unavailable);
    expect(await store.readAnalysisStatus({ studyId: 's', interviewId: 'i' })).toEqual(unavailable);
    expect(await store.beginExport({ maximum: 500 })).toEqual(unavailable);
    expect(await store.readExportPage({ sequence: 1, cursor: null, pageSize: 10, maxPageBytes: 10 })).toEqual(unavailable);
    expect(await store.verifyExportSequence({ sequence: 1 })).toBe('unavailable');
    expect(await store.readAggregateInputs({ studyId: 's', studyRevision: 1, cursor: null, pageSize: 1, maxPageBytes: 1 })).toEqual(unavailable);

    expect(await store.createStudy(await createStudyInput())).toEqual(ambiguous);
    expect(await store.replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 })).toEqual(ambiguous);
    expect(await store.setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 })).toEqual(ambiguous);
    expect(await store.deleteStudy({ studyId: study.id, now: T0 }))
      .toEqual({ status: 'ambiguous', success: false, error: 'Failed to delete study', reason: 'ambiguous' });
    expect(await store.createParticipantLink({ studyId: study.id, studyRevision: 1, expiresAt: null, now: T0 })).toEqual(ambiguous);
    expect(await store.revokeParticipantLink({ studyId: study.id, linkId: 'a'.repeat(64), now: T0 })).toEqual(ambiguous);
    expect(await store.clearSampleWorkspace({ studyIds: [], interviewIds: [] })).toEqual(ambiguous);

    // Unions without an ambiguous member stay unavailable; callers replay with the same identity.
    expect(await store.recordConsent({ participantSessionId: 'p', studyId: 's', studyRevision: 1, consentText: 't', now: T0 })).toEqual(unavailable);
    expect(await store.admitParticipantRequest({ operation: 'greeting', counters: [{ key: 'k', maximum: 1, windowSeconds: 1 }], now: T0 })).toEqual(unavailable);
    expect(await store.saveAggregate({
      studyId: 's', studyRevision: 1, interviewIds: ['i'], interviewCount: 1, aiProvider: 'openai', aiModel: 'm',
      commonThemes: [], divergentViews: [], keyFindings: [], researchImplications: [], bottomLine: '', generatedAt: T0, savedAt: T0,
    })).toBe('unavailable');
    expect(await store.seedSampleWorkspace({ studies: [], interviews: [], now: T0 })).toEqual(unavailable);
    expect(await store.acceptAnalysisRetry({
      studyId: 's', interviewId: 'i', expectedGeneration: 0, input: frozenInput(study), now: T0, rawIdempotencyKey: 'k', apiVersion: 2,
    })).toEqual(unavailable);
  });

  it('ST-01: a committed-but-lost completion reply is reported as ambiguous, never created', async () => {
    const fake = fakeNamespace(() => {
      throw new Error('synthetic lost reply');
    });
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    const study = (await createStudyInput()).candidate;
    const participant = { study, linkId: 'a'.repeat(64), sessionId: crypto.randomUUID(), consentHash: 'b'.repeat(64), consentAcceptedAt: T0 };
    expect(await store.persistCompletedInterview({
      interview: interviewRecord(participant),
      fingerprint: 'c'.repeat(64),
      expectedStudyRevision: 1,
      allowDisabledLinks: false,
      ratePlan: [],
      identity: { participantSessionId: participant.sessionId, linkId: participant.linkId },
      consent: { participantSessionId: participant.sessionId, studyId: study.id, studyRevision: 1, consentText: 'text' },
      initialAnalysis: frozenInput(study),
      now: T0,
    })).toEqual({ status: 'ambiguous' });
  });

  it('ST-01: malformed RPC replies are refused and export sequence checks return the bare status', async () => {
    const replies: Record<string, unknown> = { getStudy: null, verifyExportSequence: { status: 'changed' }, saveAggregate: { status: 'saved' } };
    const fake = fakeNamespace((method) => replies[method]);
    const store = createDurableWorkspaceStore({ namespace: fake.namespace, workspaceId: testEnv.WORKSPACE_ID, jurisdiction: '', rateLimitSalt: SALT });
    expect(await store.getStudy('s')).toEqual({ status: 'unavailable' });
    expect(await store.verifyExportSequence({ sequence: 3 })).toBe('changed');
    expect(await store.saveAggregate({
      studyId: 's', studyRevision: 1, interviewIds: ['i'], interviewCount: 1, aiProvider: 'openai', aiModel: 'm',
      commonThemes: [], divergentViews: [], keyFindings: [], researchImplications: [], bottomLine: '', generatedAt: T0, savedAt: T0,
    })).toBe('unavailable');
  });
});
