// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  hashConsentText,
  PARTICIPANT_CONSENT_TTL_SECONDS,
  recordParticipantConsent,
  verifyParticipantConsent,
} from '@/lib/participantConsent';

const binding = {
  participantSessionId: 'participant-session-a',
  studyId: 'study-a',
  studyRevision: 3,
  consentText: 'Canonical consent text.',
};

const consentRecord = {
  version: 1 as const,
  participantSessionId: binding.participantSessionId,
  studyId: binding.studyId,
  studyRevision: binding.studyRevision,
  consentHash: hashConsentText(binding.consentText),
  acceptedAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('participant consent storage', () => {
  it('atomically records the canonical binding with a four-hour TTL and server time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(consentRecord.acceptedAt);
    const evalMock = vi.fn().mockImplementation(
      (_script: string, _keys: string[], args: string[]) => JSON.parse(args[0])
    );
    const client = { eval: evalMock } as unknown as RedisPort;

    await expect(recordParticipantConsent(binding, client)).resolves.toEqual({
      status: 'accepted',
      consent: consentRecord,
    });

    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])");
    expect(keys[0]).toMatch(/^participant-consent:[a-f0-9]{64}$/);
    expect(keys[0]).not.toContain(binding.participantSessionId);
    expect(args[1]).toBe(String(PARTICIPANT_CONSENT_TTL_SECONDS));
    expect(JSON.parse(args[0])).toEqual(consentRecord);
  });

  it('returns the original acceptedAt for an idempotent retry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(consentRecord.acceptedAt + 10_000);
    const client = { eval: vi.fn().mockResolvedValue(consentRecord) } as unknown as RedisPort;

    await expect(recordParticipantConsent(binding, client)).resolves.toEqual({
      status: 'accepted',
      consent: consentRecord,
    });
  });

  it('rejects a stored record bound to different consent', async () => {
    const client = {
      eval: vi.fn().mockResolvedValue({ ...consentRecord, consentHash: 'b'.repeat(64) }),
    } as unknown as RedisPort;

    await expect(recordParticipantConsent(binding, client)).resolves.toEqual({ status: 'conflict' });
  });

  it('distinguishes accepted, missing, mismatched, and unavailable reads', async () => {
    const acceptedClient = { get: vi.fn().mockResolvedValue(consentRecord) } as unknown as RedisPort;
    const missingClient = { get: vi.fn().mockResolvedValue(null) } as unknown as RedisPort;
    const mismatchedClient = {
      get: vi.fn().mockResolvedValue({ ...consentRecord, studyRevision: 2 }),
    } as unknown as RedisPort;
    const unavailableClient = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as RedisPort;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(verifyParticipantConsent(binding, acceptedClient)).resolves.toEqual({
      status: 'accepted',
      consent: consentRecord,
    });
    await expect(verifyParticipantConsent(binding, missingClient)).resolves.toEqual({ status: 'missing' });
    await expect(verifyParticipantConsent(binding, mismatchedClient)).resolves.toEqual({ status: 'mismatch' });
    await expect(verifyParticipantConsent(binding, unavailableClient)).resolves.toEqual({ status: 'unavailable' });
  });
});
