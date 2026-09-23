import { beforeEach, describe, expect, it } from 'vitest';
import { evictDurableObject, reset } from 'cloudflare:test';
import { workspaceStub } from './helpers';
import {
  candidateStudy,
  count,
  createStudy,
  createStudyInput,
  currentStudy,
  DAY,
  enrolParticipant,
  mutationSeq,
  persistInput,
  randomHex64,
  setMaintenance,
  sql,
  T0,
} from './fixtures';

beforeEach(async () => {
  await reset();
});

const RECEIPT_TTL = 7 * DAY;

function aggregateFor(studyId: string) {
  return {
    studyId,
    studyRevision: 1,
    interviewIds: ['session-synthetic-a', 'session-synthetic-b'],
    interviewCount: 2,
    aiProvider: 'openai' as const,
    aiModel: 'gpt-5.6-terra',
    commonThemes: [],
    divergentViews: [],
    keyFindings: [],
    researchImplications: [],
    bottomLine: 'Synthetic aggregate.',
    generatedAt: T0,
    savedAt: T0,
  };
}

describe('createStudy (ST-01)', () => {
  it('ST-01: creates the study with a seven-day receipt and reads it back', async () => {
    const input = await createStudyInput();
    expect(await workspaceStub().createStudy(input)).toEqual({ status: 'created', study: input.candidate, replayed: false });
    expect(await workspaceStub().getStudy({ studyId: input.candidate.id })).toEqual({ status: 'found', study: input.candidate });
    const [receipt] = await sql<{ disposition: string; target_id: string; created_at: number; expires_at: number }>(
      `SELECT disposition, target_id, created_at, expires_at FROM idempotency_receipts`,
    );
    expect(receipt).toMatchObject({ disposition: 'created', target_id: input.candidate.id });
    expect(receipt.expires_at - receipt.created_at).toBe(RECEIPT_TTL);
  });

  it('ST-01: a same-key same-fingerprint replay returns the original study without a second row', async () => {
    const input = await createStudyInput();
    await workspaceStub().createStudy(input);
    await workspaceStub().replaceStudyConfig({
      studyId: input.candidate.id,
      expectedRevision: 1,
      config: { ...input.candidate.config, name: 'Edited later' },
      now: T0,
    });

    // A retried HTTP request re-mints its candidate; the receipt still wins.
    const retried = { ...input, candidate: { ...candidateStudy(), config: input.candidate.config } };
    retried.candidate.config = { ...retried.candidate.config, id: retried.candidate.id };
    expect(await workspaceStub().createStudy(retried)).toEqual({ status: 'created', study: input.candidate, replayed: true });
    expect(await count('studies')).toBe(1);
    expect(await count('idempotency_receipts')).toBe(1);
  });

  it('ST-01: a reused key with another fingerprint is key-reuse', async () => {
    const input = await createStudyInput();
    await workspaceStub().createStudy(input);
    const other = candidateStudy({ name: 'Different intent' });
    expect(await workspaceStub().createStudy({ ...input, fingerprint: randomHex64(), candidate: other }))
      .toEqual({ status: 'key-reuse' });
    expect(await count('studies')).toBe(1);
  });

  it('ST-01/ST-07: after deletion the create key is consumed and the id stays fenced', async () => {
    const input = await createStudyInput();
    await workspaceStub().createStudy(input);
    expect(await workspaceStub().deleteStudy({ studyId: input.candidate.id, now: T0 })).toEqual({ status: 'deleted', success: true });

    expect(await workspaceStub().createStudy(input)).toEqual({ status: 'key-consumed' });
    const recreate = await createStudyInput(input.candidate);
    expect(await workspaceStub().createStudy(recreate)).toEqual({ status: 'conflict' });
    expect(await count('studies')).toBe(0);
  });

  it('ST-01: a different study already holding the candidate id conflicts', async () => {
    const first = await createStudy();
    const clash = { ...candidateStudy(), id: first.id };
    clash.config = { ...clash.config, id: first.id, name: 'Clash' };
    expect(await workspaceStub().createStudy(await createStudyInput(clash))).toEqual({ status: 'conflict' });
    expect((await currentStudy(first.id)).config.name).toBe(first.config.name);
  });

  it('ST-01: the create quota counts only unexpired receipts and an expired key can be used again', async () => {
    const now = Date.now();
    for (let index = 0; index < 100; index += 1) {
      await sql(
        `INSERT INTO idempotency_receipts
           (operation_family, key_digest, fingerprint, target_id, disposition, result_json, created_at, expires_at)
         VALUES ('study-create', ?, ?, NULL, 'created', NULL, ?, ?)`,
        randomHex64(),
        randomHex64(),
        now,
        now + DAY,
      );
    }
    const blocked = await createStudyInput();
    expect(await workspaceStub().createStudy(blocked)).toEqual({ status: 'quota' });
    expect(await count('studies')).toBe(0);

    await sql(`UPDATE idempotency_receipts SET expires_at = ?`, now - 1);
    const expiredKey = (await sql<{ key_digest: string }>(`SELECT key_digest FROM idempotency_receipts LIMIT 1`))[0].key_digest;
    const reused = { ...(await createStudyInput()), idempotencyKeyDigest: expiredKey };
    expect(await workspaceStub().createStudy(reused)).toMatchObject({ status: 'created', replayed: false });
    expect(await sql(`SELECT target_id FROM idempotency_receipts WHERE key_digest = ?`, expiredKey))
      .toEqual([{ target_id: reused.candidate.id }]);
  });

  it('ST-01: malformed create input is refused without a write', async () => {
    const input = await createStudyInput();
    const mismatched = { ...input, candidate: { ...input.candidate, config: { ...input.candidate.config, id: 'other-id' } } };
    expect(await workspaceStub().createStudy(mismatched)).toEqual({ status: 'unavailable' });
    expect(await workspaceStub().createStudy({ ...input, fingerprint: 'not-a-digest' })).toEqual({ status: 'unavailable' });
    expect(await count('studies')).toBe(0);
  });
});

describe('study reads (ST-01, ST-05)', () => {
  it('ST-01: listStudies counts before loading and orders newest first with an id tie-break', async () => {
    const ids = ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003'];
    const created = [T0, T0 + 1, T0 + 1];
    for (let index = 0; index < ids.length; index += 1) {
      const candidate = { ...candidateStudy(), id: ids[index], createdAt: created[index], updatedAt: created[index] };
      candidate.config = { ...candidate.config, id: ids[index] };
      await workspaceStub().createStudy(await createStudyInput(candidate));
    }
    expect(await workspaceStub().listStudies({ maximum: 2 })).toEqual({ status: 'too-large', count: 3, maximum: 2 });
    const listed = await workspaceStub().listStudies({ maximum: 3 });
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.items.map((study) => study.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('ST-05: an undecodable study reads as absent (Redis parity), is left out of lists and is never patched', async () => {
    const good = await createStudy();
    const bad = await createStudy();
    await sql(`UPDATE studies SET config_json = ? WHERE id = ?`, '{"id":', bad.id);

    expect(await workspaceStub().getStudy({ studyId: bad.id })).toEqual({ status: 'not-found' });
    const listed = await workspaceStub().listStudies({ maximum: 10 });
    expect(listed.status === 'ok' && listed.items.map((study) => study.id)).toEqual([good.id]);
    expect(await workspaceStub().replaceStudyConfig({ studyId: bad.id, expectedRevision: 1, config: bad.config, now: T0 }))
      .toEqual({ status: 'unavailable' });
    expect(await sql(`SELECT config_json, revision FROM studies WHERE id = ?`, bad.id)).toEqual([{ config_json: '{"id":', revision: 1 }]);
  });
});

describe('revision-bumping mutations (ST-03)', () => {
  it('ST-03: replaceStudyConfig is an expected-revision compare-and-set that preserves count and lock', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    expect((await workspaceStub().persistCompletedInterview(await persistInput(participant))).status).toBe('created');

    const config = { ...study.config, name: 'Edited synthetic study' };
    const updated = await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config, now: T0 + 5 });
    expect(updated).toEqual({
      status: 'updated',
      study: { ...study, config, revision: 2, updatedAt: T0 + 5, interviewCount: 1, isLocked: true },
    });
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config, now: T0 + 6 }))
      .toEqual({ status: 'conflict' });
    expect(await workspaceStub().replaceStudyConfig({ studyId: 'missing-study', expectedRevision: 1, config: { ...config, id: 'missing-study' }, now: T0 }))
      .toEqual({ status: 'not-found' });
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 2, config: { ...config, id: 'other' }, now: T0 }))
      .toEqual({ status: 'unavailable' });
    expect((await currentStudy(study.id)).revision).toBe(2);
  });

  it('ST-03: toggling links advances the revision and patches only linksEnabled', async () => {
    const study = await createStudy({ interviewerInstructions: 'Keep it synthetic.' });
    const disabled = await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: false, now: T0 });
    expect(disabled).toEqual({
      status: 'updated',
      study: { ...study, config: { ...study.config, linksEnabled: false }, revision: 2, updatedAt: T0 },
    });
    const [row] = await sql<{ config_json: string }>(`SELECT config_json FROM studies WHERE id = ?`, study.id);
    expect(row.config_json).toBe(JSON.stringify({ ...study.config, linksEnabled: false }));
    const enabled = await workspaceStub().setStudyLinksEnabled({ studyId: study.id, enabled: true, now: T0 + 1 });
    expect(enabled.status === 'updated' && enabled.study.revision).toBe(3);
  });
});

describe('deleteStudy (ST-07)', () => {
  it('ST-07: a refused populated delete has no side effects, so later edits and saves still succeed', async () => {
    const study = await createStudy();
    const first = await enrolParticipant(study);
    const second = await enrolParticipant(study);
    expect((await workspaceStub().persistCompletedInterview(await persistInput(first))).status).toBe('created');
    await workspaceStub().saveAggregate({ aggregate: aggregateFor(study.id), now: T0 });
    const seq = await mutationSeq();
    const snapshot = {
      studies: await sql(`SELECT * FROM studies`),
      links: await sql(`SELECT * FROM participant_links`),
      aggregates: await sql(`SELECT * FROM aggregates`),
      receipts: await sql(`SELECT * FROM idempotency_receipts`),
      fences: await sql(`SELECT * FROM deletion_fences`),
    };

    expect(await workspaceStub().deleteStudy({ studyId: study.id, now: T0 })).toEqual({
      status: 'conflict',
      success: false,
      error: 'Cannot delete study with existing interviews',
    });
    expect({
      studies: await sql(`SELECT * FROM studies`),
      links: await sql(`SELECT * FROM participant_links`),
      aggregates: await sql(`SELECT * FROM aggregates`),
      receipts: await sql(`SELECT * FROM idempotency_receipts`),
      fences: await sql(`SELECT * FROM deletion_fences`),
    }).toEqual(snapshot);
    expect(await mutationSeq()).toBe(seq);

    // The Redis script left an in-flight guard here; the durable store does not.
    expect((await workspaceStub().persistCompletedInterview(await persistInput(second))).status).toBe('created');
    const edited = await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 });
    expect(edited.status).toBe('updated');
  });

  it('ST-07: deleting an unknown study succeeds without writing anything', async () => {
    const seq = await mutationSeq();
    expect(await workspaceStub().deleteStudy({ studyId: 'b0000000-0000-4000-8000-00000000000f', now: T0 }))
      .toEqual({ status: 'deleted', success: true });
    expect(await count('deletion_fences')).toBe(0);
    expect(await mutationSeq()).toBe(seq);
  });

  it('ST-07: deletion cascades links, consent and aggregate, fences the id through restart and marks the receipt', async () => {
    const input = await createStudyInput();
    await workspaceStub().createStudy(input);
    const study = input.candidate;
    await enrolParticipant(study);
    expect(await workspaceStub().saveAggregate({ aggregate: aggregateFor(study.id), now: T0 })).toBe('saved');
    const other = await createStudy();
    await enrolParticipant(other);
    const seq = await mutationSeq();

    expect(await workspaceStub().deleteStudy({ studyId: study.id, now: T0 })).toEqual({ status: 'deleted', success: true });

    expect(await count('studies', 'id = ?', study.id)).toBe(0);
    expect(await count('participant_links', 'study_id = ?', study.id)).toBe(0);
    expect(await count('consents', 'study_id = ?', study.id)).toBe(0);
    expect(await count('aggregates', 'study_id = ?', study.id)).toBe(0);
    expect(await count('participant_links', 'study_id = ?', other.id)).toBe(1);
    expect(await count('consents', 'study_id = ?', other.id)).toBe(1);
    expect(await sql(`SELECT disposition FROM idempotency_receipts WHERE target_id = ?`, study.id)).toEqual([{ disposition: 'deleted' }]);
    expect(await mutationSeq()).toBe(seq + 1);

    await evictDurableObject(workspaceStub());
    expect(await sql(`SELECT kind, target_id, deleted_at, expires_at, sample_fixture FROM deletion_fences`))
      .toEqual([{ kind: 'study', target_id: study.id, deleted_at: T0, expires_at: T0 + 30 * DAY, sample_fixture: 0 }]);
    expect(await workspaceStub().saveAggregate({ aggregate: aggregateFor(study.id), now: T0 + 1 })).toBe('study-not-found');
    expect(await workspaceStub().deleteStudy({ studyId: study.id, now: T0 + 1 })).toEqual({ status: 'deleted', success: true });
  });
});

describe('maintenance holds (OPS-01)', () => {
  it('OPS-01: researcher mutations are held outside open while reads continue', async () => {
    const study = await createStudy();
    await setMaintenance('draining');
    expect(await workspaceStub().createStudy(await createStudyInput())).toEqual({ status: 'held', reason: 'maintenance' });
    expect(await workspaceStub().replaceStudyConfig({ studyId: study.id, expectedRevision: 1, config: study.config, now: T0 }))
      .toEqual({ status: 'held', reason: 'maintenance' });
    expect(await workspaceStub().deleteStudy({ studyId: study.id, now: T0 }))
      .toEqual({ status: 'held', reason: 'maintenance', success: false });
    await setMaintenance('frozen');
    expect((await workspaceStub().getStudy({ studyId: study.id })).status).toBe('found');
    expect((await workspaceStub().listStudies({ maximum: 10 })).status).toBe('ok');
  });
});
