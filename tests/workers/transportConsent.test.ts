// D9 in the real WorkspaceStore: the transport disclosed at consent is
// recorded with the consent, must travel unchanged to the saved interview and
// the initial generation's frozen input, and is part of the consent's
// identity. Older rows without it keep parsing (they are direct), and the N-1
// readers accept every row this build writes (rollback).
import { beforeEach, describe, expect, it } from 'vitest';
import { reset } from 'cloudflare:test';
import { workspaceStub } from './helpers';
import {
  createStudy,
  enrolParticipant,
  frozenInput,
  persistInput,
  randomHex64,
  sql,
  T0,
} from './fixtures';
import { isValidFrozenN1, parseConsentRecordN1 } from './n1/readers.n1';
import { parseRecord as parseRecordN1 } from './n1/projection.n1';

beforeEach(async () => {
  await reset();
});

async function consentRow(): Promise<Record<string, unknown>> {
  const [row] = await sql<{ record_json: string }>('SELECT record_json FROM consents');
  return JSON.parse(row.record_json);
}

describe('consent records the disclosed transport (D9)', () => {
  it('stores the gateway disclosure, returns it on verification, and replays only under the same disclosure', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, { disclosedTransport: 'cloudflare-gateway' });
    expect(await consentRow()).toMatchObject({ disclosedTransport: 'cloudflare-gateway' });

    const binding = {
      participantSessionId: participant.sessionId,
      studyId: study.id,
      studyRevision: study.revision,
      consentHash: participant.consentHash,
      now: T0,
    };
    expect(await workspaceStub().verifyConsent(binding))
      .toMatchObject({ status: 'accepted', consent: { disclosedTransport: 'cloudflare-gateway' } });
    expect(await workspaceStub().recordConsent({ ...binding, disclosedTransport: 'cloudflare-gateway' }))
      .toMatchObject({ status: 'accepted', consent: { acceptedAt: participant.consentAcceptedAt } });
    // The same session under another notice is a conflict, never a silent rewrite.
    expect(await workspaceStub().recordConsent(binding)).toEqual({ status: 'conflict' });
    expect(await consentRow()).toMatchObject({ disclosedTransport: 'cloudflare-gateway' });
  });

  it('a direct consent carries no disclosure member and refuses a replay that claims the gateway', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    expect(await consentRow()).not.toHaveProperty('disclosedTransport');
    expect(await workspaceStub().recordConsent({
      participantSessionId: participant.sessionId,
      studyId: study.id,
      studyRevision: study.revision,
      consentHash: participant.consentHash,
      now: T0,
      disclosedTransport: 'cloudflare-gateway',
    })).toEqual({ status: 'conflict' });
  });

  it('refuses an unknown disclosure value at the store boundary', async () => {
    const study = await createStudy();
    expect(await workspaceStub().recordConsent({
      participantSessionId: crypto.randomUUID(),
      studyId: study.id,
      studyRevision: study.revision,
      consentHash: randomHex64(),
      now: T0,
      disclosedTransport: 'vercel' as never,
    })).toEqual({ status: 'conflict' });
    expect(await sql('SELECT COUNT(*) AS n FROM consents')).toEqual([{ n: 0 }]);
  });

  it('a stored record with an unknown disclosure is malformed (missing), never read as direct', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, { disclosedTransport: 'cloudflare-gateway' });
    await sql(`UPDATE consents SET record_json = json_set(record_json, '$.disclosedTransport', 'direct')`);
    expect(await workspaceStub().verifyConsent({
      participantSessionId: participant.sessionId,
      studyId: study.id,
      studyRevision: study.revision,
      consentHash: participant.consentHash,
      now: T0,
    })).toEqual({ status: 'missing' });
  });
});

describe('completion carries the disclosure to the record and the frozen input (D9)', () => {
  it('commits a gateway-consented interview with consentTransport and a frozen disclosure', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, { disclosedTransport: 'cloudflare-gateway' });
    const input = await persistInput(participant);
    expect(input.interview.consentTransport).toBe('cloudflare-gateway');

    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'created' });

    const [job] = await sql<{ input_json: string }>('SELECT input_json FROM analysis_jobs');
    expect(JSON.parse(job.input_json)).toEqual(frozenInput(study, 'cloudflare-gateway'));
    const read = await workspaceStub().getInterview({ interviewId: input.interview.id });
    expect(read).toMatchObject({ status: 'found', interview: { consentTransport: 'cloudflare-gateway' } });
  });

  it.each([
    ['the record omits the gateway disclosure', 'cloudflare-gateway', { interview: 'absent' }],
    ['the frozen input omits the gateway disclosure', 'cloudflare-gateway', { frozen: 'absent' }],
    ['the record claims a gateway disclosure the consent lacks', undefined, { interview: 'gateway' }],
    ['the frozen input claims a gateway disclosure the consent lacks', undefined, { frozen: 'gateway' }],
  ] as const)('refuses a completion where %s', async (_label, disclosed, change) => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, disclosed ? { disclosedTransport: disclosed } : {});
    const base = await persistInput(participant);
    const interview = { ...base.interview };
    if ('interview' in change) {
      if (change.interview === 'absent') delete interview.consentTransport;
      else interview.consentTransport = 'cloudflare-gateway';
    }
    const initialAnalysis = 'frozen' in change
      ? frozenInput(study, change.frozen === 'gateway' ? 'cloudflare-gateway' : undefined)
      : base.initialAnalysis;

    expect(await workspaceStub().persistCompletedInterview({ ...base, interview, initialAnalysis }))
      .toEqual({ status: 'conflict' });
    expect(await sql('SELECT COUNT(*) AS n FROM interviews')).toEqual([{ n: 0 }]);
    expect(await sql('SELECT COUNT(*) AS n FROM analysis_jobs')).toEqual([{ n: 0 }]);
  });

  it('a direct completion is unchanged: no disclosure on the record, the consent or the frozen input', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study);
    const input = await persistInput(participant);
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'created' });
    const [job] = await sql<{ input_json: string }>('SELECT input_json FROM analysis_jobs');
    expect(JSON.parse(job.input_json)).toEqual(frozenInput(study));
    const [record] = await sql<{ record_json: string }>('SELECT record_json FROM interviews');
    expect(JSON.parse(record.record_json)).not.toHaveProperty('consentTransport');
  });
});

describe('N-1 rollback readers accept what this build writes (gw-final NEW 4, §11 item 14)', () => {
  it('the N-1 consent, completion-input and record readers accept gateway rows', async () => {
    const study = await createStudy();
    const participant = await enrolParticipant(study, { disclosedTransport: 'cloudflare-gateway' });
    const input = await persistInput(participant);
    expect(await workspaceStub().persistCompletedInterview(input)).toEqual({ status: 'created' });

    const [consent] = await sql<{ record_json: string }>('SELECT record_json FROM consents');
    expect(parseConsentRecordN1(consent.record_json)).toMatchObject({
      participantSessionId: participant.sessionId,
      consentHash: participant.consentHash,
    });

    const [job] = await sql<{ input_json: string }>('SELECT input_json FROM analysis_jobs');
    expect(isValidFrozenN1(JSON.parse(job.input_json), study.id, study.revision)).toBe(true);

    const [record] = await sql<{ id: string; record_json: string }>('SELECT id, record_json FROM interviews');
    expect(parseRecordN1(record.record_json, record.id)).toMatchObject({ id: record.id, consentTransport: 'cloudflare-gateway' });
  });
});
