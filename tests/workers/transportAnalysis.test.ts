// D9 and D11 in the real WorkspaceStore's analysis RPCs: a researcher retry
// allocates a paid generation only when the interview's recorded disclosure
// covers the transport the request would use, and freezes that disclosure;
// the object never attaches a result produced on an uncovered transport; and
// `aiTransport` provenance is stored, projected, and readable by N-1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_COLUMNS, type AnalysisRow } from '../../cloudflare/workspace/projection';
import {
  QUEUED_SYNTHESIS_DEADLINE_MS,
  ANALYSIS_ATTACH_MARGIN_MS,
  type AcceptAnalysisRetryInput,
} from '../../src/lib/storage/analysisProtocol';
import { workspaceStub } from './helpers';
import {
  analysisRow,
  captureQueue,
  fenceOf,
  frozenInput,
  jobRow,
  PROVIDER_MODELS,
  resetWorkspace,
  seedInterview,
  seedJob,
  sqlRows,
  SYNTHESIS,
  type SeededInterview,
  type SeededJob,
} from './jobFixtures';
import { isFrozenInputN1, validateProvenanceN1 } from './n1/readers.n1';
import { projectInterview as projectInterviewN1 } from './n1/projection.n1';

beforeEach(async () => {
  await resetWorkspace();
  captureQueue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function retryInput(seeded: SeededInterview, overrides: Partial<AcceptAnalysisRetryInput> = {}): AcceptAnalysisRetryInput {
  return {
    studyId: seeded.studyId,
    interviewId: seeded.interviewId,
    requestKeyDigest: `digest-${crypto.randomUUID()}`,
    requestFingerprint: 'fingerprint-v2-expected-0',
    expectedGeneration: 0,
    input: frozenInput(seeded.config, 1),
    now: Date.now(),
    ...overrides,
  };
}

async function latestJobInput(interviewId: string): Promise<Record<string, unknown>> {
  const rows = await sqlRows<{ input_json: string }>(
    'SELECT input_json FROM analysis_jobs WHERE interview_id = ? ORDER BY generation DESC LIMIT 1',
    interviewId,
  );
  return JSON.parse(rows[0].input_json);
}

describe('researcher retry is allocated only on a covered transport (D9)', () => {
  it('refuses a gateway retry of a direct-consented interview, allocating nothing', async () => {
    const seeded = await seedInterview({ provider: 'claude' });
    const outcome = await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { transport: 'cloudflare-gateway' }));
    expect(outcome).toEqual({ status: 'transport-not-disclosed' });
    expect(await sqlRows('SELECT job_id FROM analysis_jobs WHERE interview_id = ?', seeded.interviewId)).toEqual([]);
  });

  it('accepts a gateway retry of a gateway-consented interview and freezes the recorded disclosure', async () => {
    const seeded = await seedInterview({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    const outcome = await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { transport: 'cloudflare-gateway' }));
    expect(outcome).toMatchObject({ status: 'accepted', body: { generation: 1 } });
    expect(await latestJobInput(seeded.interviewId)).toEqual(frozenInput(seeded.config, 1, 'cloudflare-gateway'));
  });

  it('a direct retry is always covered, and still freezes the interview\'s own disclosure', async () => {
    const seeded = await seedInterview({ provider: 'openai', disclosedTransport: 'cloudflare-gateway' });
    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded)))
      .toMatchObject({ status: 'accepted' });
    expect(await latestJobInput(seeded.interviewId)).toMatchObject({ disclosedTransport: 'cloudflare-gateway' });
  });

  it('the caller cannot supply a disclosure the interview does not carry', async () => {
    const seeded = await seedInterview({ provider: 'openai' });
    const forged = { ...frozenInput(seeded.config, 1), disclosedTransport: 'cloudflare-gateway' as const };
    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { input: forged, transport: 'cloudflare-gateway' })))
      .toEqual({ status: 'transport-not-disclosed' });
    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { input: forged })))
      .toMatchObject({ status: 'accepted' });
    expect(await latestJobInput(seeded.interviewId)).not.toHaveProperty('disclosedTransport');
  });

  it('refuses an unknown transport value as invalid input', async () => {
    const seeded = await seedInterview({ provider: 'openai' });
    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { transport: 'vercel' as never })))
      .toEqual({ status: 'unavailable' });
  });
});

async function finishComplete(job: SeededJob, provenance: Record<string, unknown>) {
  const stub = workspaceStub();
  const claimNonce = crypto.randomUUID();
  const claimed = await stub.claimAnalysisJob({ ...fenceOf(job), claimNonce, now: Date.now() });
  expect(claimed.status).toBe('claimed');
  const started = await stub.markAnalysisStarted({
    ...fenceOf(job),
    claimNonce,
    requiredRemainingMs: QUEUED_SYNTHESIS_DEADLINE_MS + ANALYSIS_ATTACH_MARGIN_MS,
    now: Date.now(),
  });
  expect(started.status).toBe('started');
  return stub.finishAnalysisJob({
    ...fenceOf(job),
    claimNonce,
    now: Date.now(),
    outcome: { kind: 'complete', synthesis: SYNTHESIS, provenance: provenance as never },
  });
}

const gatewayProvenance = (provider: 'claude' | 'openai') => ({
  aiProvider: provider,
  aiModel: PROVIDER_MODELS[provider].served,
  requestedAiModel: PROVIDER_MODELS[provider].requested,
  aiTransport: 'cloudflare-gateway',
});

describe('attachment refuses a result from an uncovered transport (D9, D11)', () => {
  it('never attaches a gateway result to a direct-consented generation', async () => {
    const job = await seedJob({ provider: 'claude' });
    expect(await finishComplete(job, gatewayProvenance('claude'))).toEqual({ status: 'written', replayed: false });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'invalid-output' });
    expect(await analysisRow(job.interviewId)).toMatchObject({ status: 'failed', synthesis_json: null });
  });

  it('refuses a non-literal aiTransport', async () => {
    const job = await seedJob({ provider: 'claude', disclosedTransport: 'cloudflare-gateway' });
    await finishComplete(job, { ...gatewayProvenance('claude'), aiTransport: 'vercel' });
    expect(await jobRow(job.jobId)).toMatchObject({ state: 'failed', failure_kind: 'invalid-output' });
  });

  it('attaches a gateway result to a gateway-consented generation and projects aiTransport', async () => {
    const job = await seedJob({ provider: 'openai', disclosedTransport: 'cloudflare-gateway' });
    expect(await finishComplete(job, gatewayProvenance('openai'))).toEqual({ status: 'written', replayed: false });
    const row = await analysisRow(job.interviewId);
    expect(JSON.parse(row?.provenance_json ?? 'null')).toEqual(gatewayProvenance('openai'));
    expect(await workspaceStub().getInterview({ interviewId: job.interviewId }))
      .toMatchObject({ status: 'found', interview: { aiTransport: 'cloudflare-gateway', aiModel: PROVIDER_MODELS.openai.served } });
  });
});

describe('N-1 rollback readers accept this build\'s analysis rows (gw-final NEW 4, §11 item 14)', () => {
  it('the N-1 frozen-input, provenance and projection readers accept gateway rows', async () => {
    const job = await seedJob({ provider: 'openai', disclosedTransport: 'cloudflare-gateway' });
    await finishComplete(job, gatewayProvenance('openai'));

    const input = await latestJobInput(job.interviewId);
    expect(isFrozenInputN1(input)).toBe(true);

    const [analysis] = await sqlRows<AnalysisRow>(`SELECT ${ANALYSIS_COLUMNS} FROM analysis WHERE interview_id = ?`, job.interviewId);
    const provenance = JSON.parse(analysis.provenance_json as string);
    expect(validateProvenanceN1(provenance)).toEqual({
      aiProvider: 'openai',
      aiModel: PROVIDER_MODELS.openai.served,
      requestedAiModel: PROVIDER_MODELS.openai.requested,
    });

    const [record] = await sqlRows<{ record_json: string }>('SELECT record_json FROM interviews WHERE id = ?', job.interviewId);
    const projected = projectInterviewN1(record.record_json, job.interviewId, analysis);
    expect(projected).toMatchObject({
      id: job.interviewId,
      aiProvider: 'openai',
      aiModel: PROVIDER_MODELS.openai.served,
      synthesis: SYNTHESIS,
      analysis: { status: 'complete' },
    });
  });

  it('legacy rows without the new members still read in this build', async () => {
    const job = await seedJob({ provider: 'openai' });
    const input = await latestJobInput(job.interviewId);
    expect(input).not.toHaveProperty('disclosedTransport');
    await finishComplete(job, {
      aiProvider: 'openai',
      aiModel: PROVIDER_MODELS.openai.served,
      requestedAiModel: PROVIDER_MODELS.openai.requested,
    });
    const read = await workspaceStub().getInterview({ interviewId: job.interviewId });
    expect(read).toMatchObject({ status: 'found', interview: { analysis: { status: 'complete' } } });
    expect((read as { interview: Record<string, unknown> }).interview).not.toHaveProperty('aiTransport');
  });
});

// A fixed provider commitment (lib/providerCommitment.ts): the object
// allocates a retry only for the provider and model the consent named.
describe('researcher retry keeps a fixed provider commitment', () => {
  const committed = (commitment: 'fixed' | 'may-change') => ({
    providerCommitment: commitment,
    conductedByProvider: 'openai',
    conductedByModel: PROVIDER_MODELS.openai.requested,
  });

  it('refuses a retry with another provider or model, allocating nothing', async () => {
    const seeded = await seedInterview({ provider: 'openai', record: committed('fixed') });
    const switched = [
      { ...frozenInput(seeded.config, 1), requestedProvider: 'claude' as const, requestedModel: 'claude-sonnet-5' },
      { ...frozenInput(seeded.config, 1), requestedModel: 'gpt-5.6-other' },
    ];
    for (const input of switched) {
      expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded, { input })))
        .toEqual({ status: 'provider-not-disclosed' });
    }
    expect(await sqlRows('SELECT job_id FROM analysis_jobs WHERE interview_id = ?', seeded.interviewId)).toEqual([]);
  });

  it('accepts a retry on the committed provider and model', async () => {
    const seeded = await seedInterview({ provider: 'openai', record: committed('fixed') });
    expect(await workspaceStub().acceptAnalysisRetry(retryInput(seeded))).toMatchObject({ status: 'accepted' });
  });

  it('a may-change or legacy interview accepts any provider', async () => {
    const switched = (seeded: SeededInterview) =>
      retryInput(seeded, { input: { ...frozenInput(seeded.config, 1), requestedProvider: 'claude', requestedModel: 'claude-sonnet-5' } });
    const mayChange = await seedInterview({ provider: 'openai', record: committed('may-change') });
    expect(await workspaceStub().acceptAnalysisRetry(switched(mayChange))).toMatchObject({ status: 'accepted' });
    const legacy = await seedInterview({ provider: 'openai' });
    expect(await workspaceStub().acceptAnalysisRetry(switched(legacy))).toMatchObject({ status: 'accepted' });
  });
});
