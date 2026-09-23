import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from 'cloudflare:test';
import { workspaceStub } from './helpers';
import {
  captureStoreEvents,
  count,
  createStudy,
  DAY,
  enrolParticipant,
  HOUR,
  randomHex64,
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

function linkInput(studyId: string, overrides: Partial<{ linkId: string; studyRevision: number; expiresAt: number | null; now: number }> = {}) {
  return { linkId: randomHex64(), studyId, studyRevision: 1, expiresAt: T0 + 30 * DAY, now: T0, ...overrides };
}

async function insertLink(studyId: string, values: { createdAt?: number; expiresAt?: number | null; revokedAt?: number | null } = {}) {
  const id = randomHex64();
  await sql(
    `INSERT INTO participant_links (id, study_id, study_revision, created_at, expires_at, revoked_at) VALUES (?, ?, 1, ?, ?, ?)`,
    id,
    studyId,
    values.createdAt ?? T0 - HOUR,
    values.expiresAt === undefined ? null : values.expiresAt,
    values.revokedAt ?? null,
  );
  return id;
}

describe('participant links (ST-03)', () => {
  it('ST-03: link creation stores only the digest and re-checks study, links and revision at the write', async () => {
    const study = await createStudy();
    const input = linkInput(study.id);
    expect(await workspaceStub().createParticipantLink(input)).toEqual({
      status: 'created',
      link: {
        id: input.linkId,
        version: 1,
        studyId: study.id,
        studyRevision: 1,
        researcherId: null,
        createdAt: T0,
        expiresAt: T0 + 30 * DAY,
        revokedAt: null,
      },
    });
    expect(await sql(`SELECT * FROM participant_links`)).toEqual([{
      id: input.linkId, study_id: study.id, study_revision: 1, created_at: T0, expires_at: T0 + 30 * DAY, revoked_at: null,
    }]);

    expect(await workspaceStub().createParticipantLink(input)).toEqual({ status: 'id-collision' });
    expect(await workspaceStub().createParticipantLink(linkInput(study.id, { studyRevision: 2 }))).toEqual({ status: 'revision-stale' });
    expect(await workspaceStub().createParticipantLink(linkInput('c0000000-0000-4000-8000-000000000000')))
      .toEqual({ status: 'study-not-found' });
    await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 });
    expect(await workspaceStub().createParticipantLink(linkInput(study.id, { studyRevision: 2 }))).toEqual({ status: 'links-disabled' });
    expect(await workspaceStub().createParticipantLink(linkInput(study.id, { expiresAt: T0 }))).toEqual({ status: 'unavailable' });
    expect(await count('participant_links')).toBe(1);
  });

  it('ST-03: the workspace quota counts unexpired unrevoked links only', async () => {
    const study = await createStudy();
    for (let index = 0; index < 999; index += 1) await insertLink(study.id, { expiresAt: index % 2 ? null : T0 + DAY });
    for (let index = 0; index < 5; index += 1) await insertLink(study.id, { revokedAt: T0 - 1 });
    for (let index = 0; index < 5; index += 1) await insertLink(study.id, { expiresAt: T0 });

    expect((await workspaceStub().createParticipantLink(linkInput(study.id))).status).toBe('created');
    expect(await workspaceStub().createParticipantLink(linkInput(study.id))).toEqual({ status: 'quota-exceeded' });
  });

  it('ST-03: revocation is checked before expiry and expiry is absolute at access', async () => {
    const study = await createStudy();
    const both = await insertLink(study.id, { expiresAt: T0 - 1, revokedAt: T0 - 2 });
    const expiring = await insertLink(study.id, { expiresAt: T0 + HOUR });

    expect(await workspaceStub().getParticipantLink({ linkId: both, now: T0, purpose: 'session' })).toEqual({ status: 'revoked' });
    expect((await workspaceStub().getParticipantLink({ linkId: expiring, now: T0 + HOUR - 1, purpose: 'exchange' })).status).toBe('found');
    expect(await workspaceStub().getParticipantLink({ linkId: expiring, now: T0 + HOUR, purpose: 'exchange' })).toEqual({ status: 'expired' });
    expect(await workspaceStub().getParticipantLink({ linkId: randomHex64(), now: T0, purpose: 'exchange' })).toEqual({ status: 'not-found' });
    expect(await workspaceStub().getParticipantLink({ linkId: 'not-a-digest', now: T0, purpose: 'exchange' })).toEqual({ status: 'not-found' });
  });

  it('OPS-01: draining refuses new link exchanges but keeps existing sessions and researcher reads', async () => {
    const study = await createStudy();
    const linkId = await insertLink(study.id);
    await setMaintenance('draining');
    expect(await workspaceStub().getParticipantLink({ linkId, now: T0, purpose: 'exchange' }))
      .toEqual({ status: 'held', reason: 'maintenance' });
    expect((await workspaceStub().getParticipantLink({ linkId, now: T0, purpose: 'session' })).status).toBe('found');
    await setMaintenance('frozen');
    expect(await workspaceStub().getParticipantLink({ linkId, now: T0, purpose: 'session' }))
      .toEqual({ status: 'held', reason: 'maintenance' });
    expect((await workspaceStub().getParticipantLink({ linkId, now: T0, purpose: 'researcher' })).status).toBe('found');
  });

  it('ST-05: a structurally invalid link row is unavailable, not found or active', async () => {
    const study = await createStudy();
    const linkId = await insertLink(study.id);
    await sql(`UPDATE participant_links SET created_at = 'not-a-time' WHERE id = ?`, linkId);
    expect(await workspaceStub().getParticipantLink({ linkId, now: T0, purpose: 'session' })).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().listParticipantLinks({ studyId: study.id, maximum: 10, now: T0 })).toEqual({ status: 'unavailable' });
  });

  it('ST-03: listing keeps revoked links, drops expired and foreign ones, and orders newest first', async () => {
    const study = await createStudy();
    const other = await createStudy();
    const older = await insertLink(study.id, { createdAt: T0 - 3 * HOUR });
    const revoked = await insertLink(study.id, { createdAt: T0 - 2 * HOUR, revokedAt: T0 - HOUR });
    await insertLink(study.id, { createdAt: T0 - HOUR, expiresAt: T0 });
    await insertLink(other.id, { createdAt: T0 - HOUR });
    const tieA = await insertLink(study.id, { createdAt: T0 - 10 });
    const tieB = await insertLink(study.id, { createdAt: T0 - 10 });
    const [first, second] = [tieA, tieB].sort();

    const listed = await workspaceStub().listParticipantLinks({ studyId: study.id, maximum: 10, now: T0 });
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.truncated).toBe(false);
    expect(listed.links.map((link) => link.id)).toEqual([first, second, revoked, older]);
    expect(listed.links[2]).toEqual({ id: revoked, studyRevision: 1, createdAt: T0 - 2 * HOUR, expiresAt: null, revokedAt: T0 - HOUR });

    const bounded = await workspaceStub().listParticipantLinks({ studyId: study.id, maximum: 2, now: T0 });
    expect(bounded.status === 'ok' && [bounded.links.length, bounded.truncated]).toEqual([2, true]);
  });

  it('ST-03: revocation checks owner, then expiry, then prior revocation', async () => {
    const study = await createStudy();
    const other = await createStudy();
    const active = await insertLink(study.id);
    const expired = await insertLink(study.id, { expiresAt: T0 });

    expect(await workspaceStub().revokeParticipantLink({ studyId: other.id, linkId: active, now: T0 })).toEqual({ status: 'owner-conflict' });
    expect(await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: expired, now: T0 })).toEqual({ status: 'not-found' });
    expect(await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: randomHex64(), now: T0 })).toEqual({ status: 'not-found' });
    expect(await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: active, now: T0 + 7 }))
      .toEqual({ status: 'revoked', revokedAt: T0 + 7 });
    expect(await workspaceStub().revokeParticipantLink({ studyId: study.id, linkId: active, now: T0 + 8 }))
      .toEqual({ status: 'already-revoked' });
    expect(await workspaceStub().getParticipantLink({ linkId: active, now: T0 + 9, purpose: 'session' })).toEqual({ status: 'revoked' });
  });
});

describe('consent (ST-03)', () => {
  it('ST-03: consent is first-writer-wins and a replay never renews acceptance time or absolute expiry', async () => {
    const study = await createStudy();
    const sessionId = crypto.randomUUID();
    const consentHash = await sha256Hex(study.config.consentText);
    const binding = { participantSessionId: sessionId, studyId: study.id, studyRevision: 1, consentHash };

    const first = await workspaceStub().recordConsent({ ...binding, now: T0 });
    const record = { version: 1, ...binding, acceptedAt: T0 };
    expect(first).toEqual({ status: 'accepted', consent: record });
    expect(await workspaceStub().recordConsent({ ...binding, now: T0 + HOUR })).toEqual({ status: 'accepted', consent: record });
    expect(await sql(`SELECT session_digest, study_id, expires_at FROM consents`))
      .toEqual([{ session_digest: await sha256Hex(sessionId), study_id: study.id, expires_at: T0 + 4 * HOUR }]);

    expect(await workspaceStub().verifyConsent({ ...binding, now: T0 + 4 * HOUR - 1 })).toEqual({ status: 'accepted', consent: record });
    expect(await workspaceStub().verifyConsent({ ...binding, now: T0 + 4 * HOUR })).toEqual({ status: 'missing' });
  });

  it('ST-03: another binding for the same session conflicts on record and mismatches on verify', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const other = {
      participantSessionId: participant.sessionId,
      studyId: study.id,
      studyRevision: 1,
      consentHash: randomHex64(),
    };
    expect(await workspaceStub().recordConsent({ ...other, now: T0 + 1 })).toEqual({ status: 'conflict' });
    expect(await workspaceStub().verifyConsent({ ...other, now: T0 + 1 })).toEqual({ status: 'mismatch' });
    expect(await workspaceStub().verifyConsent({ ...other, participantSessionId: crypto.randomUUID(), now: T0 + 1 }))
      .toEqual({ status: 'missing' });
    expect(await workspaceStub().verifyConsent({ ...other, participantSessionId: 'short', now: T0 + 1 }))
      .toEqual({ status: 'mismatch' });
  });

  it('ST-03: consent to a missing study or a superseded revision is refused', async () => {
    const study = await createStudy();
    const consentHash = await sha256Hex('text');
    await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 });
    expect(await workspaceStub().recordConsent({
      participantSessionId: crypto.randomUUID(), studyId: study.id, studyRevision: 1, consentHash, now: T0,
    })).toEqual({ status: 'conflict' });
    expect(await workspaceStub().recordConsent({
      participantSessionId: crypto.randomUUID(), studyId: 'no-such-study', studyRevision: 1, consentHash, now: T0,
    })).toEqual({ status: 'conflict' });
    expect(await count('consents')).toBe(0);
  });

  it('ST-05: a malformed consent row reads as missing with a corrupt diagnosis and is never overwritten by a replay', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    await sql(`UPDATE consents SET record_json = '{"version":1'`);
    const binding = {
      participantSessionId: participant.sessionId, studyId: study.id, studyRevision: 1, consentHash: participant.consentHash,
    };
    const events = captureStoreEvents();
    expect(await workspaceStub().verifyConsent({ ...binding, now: T0 })).toEqual({ status: 'missing' });
    expect(await workspaceStub().recordConsent({ ...binding, now: T0 })).toEqual({ status: 'conflict' });
    expect(events()).toEqual([
      expect.objectContaining({ reason: 'corrupt-record', operation: 'verifyConsent' }),
      expect.objectContaining({ reason: 'corrupt-record', operation: 'recordConsent' }),
    ]);
    expect(JSON.stringify(events())).not.toContain(participant.sessionId);
    expect(await sql(`SELECT record_json FROM consents`)).toEqual([{ record_json: '{"version":1' }]);
  });
});

describe('greeting/interview admission (ST-06)', () => {
  it('ST-06: a denial reports the 0-based rejected row and mutates no scope', async () => {
    await createStudy();
    const wide = randomHex64();
    const narrow = randomHex64();
    const counters = [
      { key: wide, maximum: 5, windowSeconds: 60 },
      { key: narrow, maximum: 1, windowSeconds: 600 },
    ];
    expect(await workspaceStub().admitParticipantRequest({ operation: 'greeting', counters, now: T0 })).toEqual({ status: 'admitted' });
    const before = await sql(`SELECT * FROM budget_windows ORDER BY scope_key`);

    expect(await workspaceStub().admitParticipantRequest({ operation: 'greeting', counters, now: T0 + 1_000 }))
      .toEqual({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 599 });
    expect(await sql(`SELECT * FROM budget_windows ORDER BY scope_key`)).toEqual(before);
    expect(await workspaceStub().admitParticipantRequest({ operation: 'greeting', counters, now: T0 + 599_999 }))
      .toEqual({ status: 'limited', rejectedIndex: 1, retryAfterSeconds: 1 });
  });

  it('ST-06: a window opens at first consumption, never slides and restarts after it expires', async () => {
    const key = randomHex64();
    const counters = [{ key, maximum: 2, windowSeconds: 60 }];
    await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 });
    await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 + 30_000 });
    expect(await sql(`SELECT count, expires_at FROM budget_windows`)).toEqual([{ count: 2, expires_at: T0 + 60_000 }]);
    expect((await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 + 59_999 })).status).toBe('limited');
    expect(await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 + 60_000 })).toEqual({ status: 'admitted' });
    expect(await sql(`SELECT count, window_seconds, expires_at FROM budget_windows`))
      .toEqual([{ count: 1, window_seconds: 60, expires_at: T0 + 120_000 }]);
  });

  it('ST-06: concurrent admissions never exceed the maximum', async () => {
    const counters = [{ key: randomHex64(), maximum: 3, windowSeconds: 3_600 }];
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'admitted')).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.status === 'limited')).toHaveLength(7);
    expect(await sql(`SELECT count FROM budget_windows`)).toEqual([{ count: 3 }]);
  });

  it('ST-06: a zero maximum refuses with the full window, raw keys are refused, and frozen holds admission', async () => {
    const zero = [{ key: randomHex64(), maximum: 0, windowSeconds: 600 }];
    expect(await workspaceStub().admitParticipantRequest({ operation: 'greeting', counters: zero, now: T0 }))
      .toEqual({ status: 'limited', rejectedIndex: 0, retryAfterSeconds: 600 });
    expect(await workspaceStub().admitParticipantRequest({
      operation: 'greeting',
      counters: [{ key: 'rate-limit:greeting:client:60:203.0.113.9', maximum: 5, windowSeconds: 60 }],
      now: T0,
    })).toEqual({ status: 'unavailable' });
    expect(await count('budget_windows')).toBe(0);

    const counters = [{ key: randomHex64(), maximum: 5, windowSeconds: 60 }];
    await setMaintenance('draining');
    expect((await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 })).status).toBe('admitted');
    await setMaintenance('frozen');
    expect(await workspaceStub().admitParticipantRequest({ operation: 'interview', counters, now: T0 }))
      .toEqual({ status: 'held', reason: 'maintenance' });
  });
});
