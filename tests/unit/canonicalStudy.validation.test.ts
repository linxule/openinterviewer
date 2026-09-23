// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';
import type { StudyLoadResult, WorkspaceStorePort } from '@/lib/storage/types';

import { validateStudyConfigUpdate } from '@/lib/studyConfigValidation';
import {
  frozenAnalysisInput,
  loadCanonicalStudy,
  PARTICIPANT_SAVE_HELD_COPY,
  participantContextRefusal,
  participantStoreAdmission,
  researcherHeldCopy,
  researcherPreviewHoldResponse,
  workspaceHeldResponse,
} from '@/lib/canonicalStudy';
import { ANALYSIS_INPUT_SCHEMA_VERSION } from '@/lib/storage/analysisProtocol';

const getStudy = vi.fn<(studyId: string) => Promise<StudyLoadResult>>();
const store = { getStudy };

function found(study: ReturnType<typeof makeStoredStudy>): StudyLoadResult {
  return { status: 'found', study };
}

beforeEach(() => vi.clearAllMocks());

describe('canonical study validation', () => {
  it('accepts a complete, identity-consistent canonical record', async () => {
    const study = makeStoredStudy({ id: 'study-valid', revision: 2 });
    study.config.id = study.id;
    getStudy.mockResolvedValue(found(study));

    const result = await loadCanonicalStudy({
      store,
      tokenStudyId: study.id,
    });

    expect(result).toMatchObject({ ok: true, study: { id: study.id, revision: 2 } });
    expect(getStudy).toHaveBeenCalledWith(study.id);
  });

  it('fails closed on malformed legacy canonical configuration', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const study = makeStoredStudy({ id: 'study-malformed' });
    study.config.id = study.id;
    (study.config as unknown as Record<string, unknown>).aiProvider = 'unknown-provider';
    getStudy.mockResolvedValue(found(study));

    const result = await loadCanonicalStudy({
      store,
      tokenStudyId: study.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('canonical study store outcomes (ST-01)', () => {
  it('ST-01: a confirmed miss is 404 and never a storage error', async () => {
    getStudy.mockResolvedValue({ status: 'not-found' });
    const result = await loadCanonicalStudy({ store, tokenStudyId: 'study-missing' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      await expect(result.response.json()).resolves.toEqual({ error: 'Study not found or no longer active' });
    }
  });

  it.each([
    ['reports unavailable', () => getStudy.mockResolvedValue({ status: 'unavailable' })],
    ['throws', () => getStudy.mockRejectedValue(new Error('rpc failed'))],
  ])('ST-01: a store that %s is a retryable 503, never a miss', async (_label, arrange) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    arrange();
    const result = await loadCanonicalStudy({ store, tokenStudyId: 'study-a' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Study storage is temporarily unavailable. Please try again.',
        retryable: true,
      });
    }
  });

  it('never consults the store for a missing or malformed study id', async () => {
    expect((await loadCanonicalStudy({ store })).ok).toBe(false);
    expect((await loadCanonicalStudy({ store, tokenStudyId: 'bad id!' })).ok).toBe(false);
    // A body id is honoured only for admin preview.
    expect((await loadCanonicalStudy({ store, legacyBodyStudyId: 'study-a' })).ok).toBe(false);
    expect(getStudy).not.toHaveBeenCalled();
  });
});

describe('frozen analysis inputs (JOB-02)', () => {
  it('JOB-02: freezes the canonical config, revision, provider and the explicit study model', () => {
    const study = makeStoredStudy({ id: 'study-frozen', revision: 4 });
    study.config.aiProvider = 'claude';
    study.config.aiModel = 'claude-sonnet-5';

    const frozen = frozenAnalysisInput(study);

    expect(frozen).toEqual({
      ok: true,
      input: {
        inputSchemaVersion: ANALYSIS_INPUT_SCHEMA_VERSION,
        studyConfig: study.config,
        studyRevision: 4,
        requestedProvider: 'claude',
        requestedModel: 'claude-sonnet-5',
      },
    });
  });

  it('JOB-02: a study without an explicit model is refused, never given a default model', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const study = makeStoredStudy({ id: 'study-no-model' });
    delete study.config.aiModel;

    const frozen = frozenAnalysisInput(study);

    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.response.status).toBe(503);
  });
});

describe('held durable workspace responses (OPS-01)', () => {
  it('OPS-01: maintenance is a retryable 503 with the public maintenance reason and no internal detail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = workspaceHeldResponse({ route: '/api/consent', reason: 'maintenance', error: 'Paused.' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Paused.', retryable: true, reason: 'maintenance' });
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: 'workspace.store',
      reason: 'maintenance-hold',
      status: 503,
    });
  });

  it.each([
    ['recovery-epoch-mismatch', 'epoch-mismatch'],
    ['workspace-identity-mismatch', 'workspace-identity-mismatch'],
    ['workspace-uninitialized', 'not-configured'],
    ['schema-unsupported', 'schema-unsupported'],
  ] as const)('OPS-01: %s is reported publicly only as workspace-unavailable', async (reason, logged) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = workspaceHeldResponse({ route: '/api/consent', reason, error: 'Unavailable.' });
    const body = await response.json();
    expect(body).toEqual({ error: 'Unavailable.', retryable: false, reason: 'workspace-unavailable' });
    expect(JSON.stringify(body)).not.toContain(reason);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({ reason: logged });
  });

  it('OPS-01: a workspace-unavailable hold uses its own copy; maintenance keeps the maintenance copy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const copy = researcherHeldCopy('Participant links cannot be created');
    const maintenance = workspaceHeldResponse({ route: '/api/generate-link', reason: 'maintenance', ...copy });
    const epoch = workspaceHeldResponse({ route: '/api/generate-link', reason: 'recovery-epoch-mismatch', ...copy });
    await expect(maintenance.json()).resolves.toEqual({
      error: 'Participant links cannot be created while this workspace is under maintenance.',
      retryable: true,
      reason: 'maintenance',
    });
    await expect(epoch.json()).resolves.toEqual({
      error: 'Participant links cannot be created because this workspace is unavailable. Its operator must restore it.',
      retryable: false,
      reason: 'workspace-unavailable',
    });
  });

  it('OPS-01: an unrecognized hold reason is a non-retryable workspace-unavailable hold, logged as unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = workspaceHeldResponse({
      route: '/api/studies',
      reason: 'some-future-hold' as never,
      error: 'Paused.',
      unavailableError: 'Unavailable.',
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ error: 'Unavailable.', retryable: false, reason: 'workspace-unavailable' });
    expect(JSON.stringify(body)).not.toContain('some-future-hold');
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: 'workspace.store',
      route: '/api/studies',
      status: 503,
      reason: 'unavailable',
    });
  });

  it('OPS-01: a caller that must keep unsaved data can mark any hold retryable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = workspaceHeldResponse({
      route: '/api/interviews/save',
      reason: 'recovery-epoch-mismatch',
      error: 'Not saved.',
      retryable: true,
    });
    await expect(response.json()).resolves.toMatchObject({ retryable: true, reason: 'workspace-unavailable' });
  });
});

describe('participant context refusals (OPS-01)', () => {
  const route = '/api/interviews/save';

  it('OPS-01: a 503 forwards the resolver\'s retryable flag and message', async () => {
    const response = participantContextRefusal(
      { error: 'Unable to verify participant link.', statusCode: 503, retryable: true },
      { route, error: 'Valid participant token required', held: PARTICIPANT_SAVE_HELD_COPY },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to verify participant link.', retryable: true });
  });

  it('keeps today\'s body for authentication and authority denials', async () => {
    const denied = participantContextRefusal(
      { error: 'Participant link is no longer active.', statusCode: 403, retryable: false },
      { route, error: 'Valid participant token required', held: PARTICIPANT_SAVE_HELD_COPY },
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: 'Participant link is no longer active.' });

    const unauthenticated = participantContextRefusal(
      {},
      { route, error: 'Valid participant token required', held: PARTICIPANT_SAVE_HELD_COPY },
    );
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: 'Valid participant token required' });
  });

  it.each(['maintenance', 'recovery-epoch-mismatch'] as const)(
    'OPS-01: a %s hold reported by the resolver maps through the held response with the route copy',
    async (holdReason) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const response = participantContextRefusal(
        { error: 'Unable to verify participant link.', statusCode: 503, retryable: true, holdReason },
        { route, error: 'Valid participant token required', held: PARTICIPANT_SAVE_HELD_COPY },
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'Storage is temporarily unavailable. Interview not saved. Please try again.',
        retryable: true,
        reason: holdReason === 'maintenance' ? 'maintenance' : 'workspace-unavailable',
      });
      expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({ event: 'workspace.store', route, status: 503 });
    },
  );
});

describe('participant admission through the workspace store (ST-06, OPS-01)', () => {
  const request = () => new Request('http://localhost/api/interview', { headers: { 'x-forwarded-for': '203.0.113.5' } });
  const authority = { sessionId: 'session-a', linkId: 'a'.repeat(64), researcherId: null };

  function admission(outcome: Awaited<ReturnType<WorkspaceStorePort['admitParticipantRequest']>>) {
    const admitParticipantRequest = vi.fn<WorkspaceStorePort['admitParticipantRequest']>(async () => outcome);
    return { admitParticipantRequest };
  }

  it('ST-06: admits through the store and passes the limiter\'s 429 through unchanged', async () => {
    const admitted = admission({ status: 'admitted' });
    await expect(participantStoreAdmission({
      request: request(), route: '/api/interview', studyId: 'study-a', operation: 'interview', store: admitted, authority,
    })).resolves.toBeNull();
    expect(admitted.admitParticipantRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'interview', counters: expect.any(Array) }),
    );

    const limited = await participantStoreAdmission({
      request: request(),
      route: '/api/interview',
      studyId: 'study-a',
      operation: 'interview',
      store: admission({ status: 'limited', rejectedIndex: 0, retryAfterSeconds: 30 }),
      authority,
    });
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBe('30');
  });

  it.each([
    ['maintenance', true, 'maintenance', 'This interview is paused for maintenance. Please try again later.'],
    ['workspace-uninitialized', false, 'workspace-unavailable', 'This interview is unavailable right now. Please contact the researcher.'],
  ] as const)('OPS-01: a %s store hold is a held workspace, not the limiter\'s 503', async (reason, retryable, publicReason, error) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await participantStoreAdmission({
      request: request(),
      route: '/api/greeting',
      studyId: 'study-a',
      operation: 'greeting',
      store: admission({ status: 'held', reason }),
      authority,
    });
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error, retryable, reason: publicReason });
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({ event: 'workspace.store', route: '/api/greeting' });
  });
});

describe('researcher preview maintenance gate (F26)', () => {
  function durableStore(readiness: WorkspaceStorePort['readiness']) {
    return { backend: 'durable-object', readiness: vi.fn(readiness) } as unknown as WorkspaceStorePort;
  }

  it('F26: never consults readiness on the Redis store', async () => {
    const readiness = vi.fn();
    const redis = { backend: 'redis', readiness } as unknown as WorkspaceStorePort;
    await expect(researcherPreviewHoldResponse(redis, '/api/synthesis')).resolves.toBeNull();
    expect(readiness).not.toHaveBeenCalled();
  });

  it.each(['open', 'draining'] as const)('F26: allows preview while the durable workspace is %s', async (maintenance) => {
    const store = durableStore(async () => ({ status: 'ready', maintenance }));
    await expect(researcherPreviewHoldResponse(store, '/api/synthesis')).resolves.toBeNull();
  });

  it.each(['frozen', 'recovery'] as const)('F26: refuses preview while the durable workspace is %s', async (maintenance) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = durableStore(async () => ({ status: 'ready', maintenance }));
    const response = await researcherPreviewHoldResponse(store, '/api/synthesis');
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ retryable: true, reason: 'maintenance' });
  });

  it('F26: refuses preview for a held or unreachable workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const held = durableStore(async () => ({ status: 'held', reason: 'recovery-epoch-mismatch' }));
    const heldResponse = await researcherPreviewHoldResponse(held, '/api/synthesis');
    expect(heldResponse?.status).toBe(503);
    await expect(heldResponse?.json()).resolves.toMatchObject({ reason: 'workspace-unavailable' });

    const unreachable = durableStore(async () => { throw new Error('rpc failed'); });
    const unreachableResponse = await researcherPreviewHoldResponse(unreachable, '/api/synthesis');
    expect(unreachableResponse?.status).toBe(503);
    await expect(unreachableResponse?.json()).resolves.toMatchObject({ retryable: true });
  });
});

it('serves participants after clearing instructions, with no stored empty-string field', async () => {
  const study = makeStoredStudy();
  study.config.interviewerInstructions = 'Use plain language.';
  const updated = validateStudyConfigUpdate(study.config, { interviewerInstructions: '' }, undefined);
  expect(updated.ok).toBe(true);
  if (!updated.ok) throw new Error(updated.error);
  expect(updated.config).not.toHaveProperty('interviewerInstructions');
  study.config = JSON.parse(JSON.stringify(updated.config));
  getStudy.mockResolvedValue(found(study));
  const result = await loadCanonicalStudy({ store, tokenStudyId: study.id });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.study.config.interviewerInstructions).toBeUndefined();
});

it('fails closed if a malformed stored empty instruction field is encountered', async () => {
  const study = makeStoredStudy();
  study.config.interviewerInstructions = '';
  getStudy.mockResolvedValue(found(study));
  const result = await loadCanonicalStudy({ store, tokenStudyId: study.id });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(503);
});
