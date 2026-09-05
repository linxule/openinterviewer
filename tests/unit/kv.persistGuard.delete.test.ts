// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  deleteStudy,
  persistCompletedInterviewFinish,
  replaceStudyConfigAtomic,
  setStudyLinksEnabled,
  encodePersistingGuard,
  type PersistingGuard,
} from '@/lib/kv';
import { makeStoredStudy } from '../fixtures/models';

const FINGERPRINT = 'cd'.repeat(32);

const guard: PersistingGuard = {
  version: 2,
  interviewId: 'interview-pending',
  studyId: 'study-pending',
  fingerprint: FINGERPRINT,
  expectedRevision: 1,
  deploymentMode: 'standalone',
  ratePlan: [{
    key: 'interview-rate:session:study-pending:0',
    maximum: 2,
    windowSeconds: 86_400,
    windowStart: 0,
  }],
  identity: { participantSessionId: 'session-p', linkId: 'link-p' },
  frozenUpdatedAt: 1,
};

describe('persist guard vs delete/config/link', () => {
  it('deleteStudy refuses while study-persisting is nonempty', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:still-pending']);
    const client = {
      eval: evalMock,
      get: vi.fn().mockResolvedValue(null),
    } as unknown as RedisPort;

    await expect(deleteStudy('study-pending', client)).resolves.toEqual({
      status: 'still-pending',
      success: false,
      error: 'STUDY_PERSIST_PENDING',
      code: 'STUDY_PERSIST_PENDING',
    });

    const [script, keys] = evalMock.mock.calls[0] as [string, string[]];
    expect(script).toContain("redis.call('SCARD', KEYS[6])");
    expect(script).toContain("return {'oi:still-pending'}");
    // The aggregate key (N6.1) is appended after the persist set, not last.
    expect(keys[keys.length - 2]).toBe('study-persisting:study-pending');
    expect(keys[keys.length - 1]).toBe('study-aggregate:study-pending');
  });

  it('config replace and link toggle return persist-guard without mutating', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:persist-guard']);
    const client = { eval: evalMock } as unknown as RedisPort;
    const study = makeStoredStudy({ id: 'study-pending' });

    await expect(replaceStudyConfigAtomic('study-pending', 1, study.config, client)).resolves.toEqual({
      status: 'persist-guard',
    });
    await expect(setStudyLinksEnabled('study-pending', false, client)).resolves.toEqual({
      status: 'persist-guard',
    });

    for (const call of evalMock.mock.calls) {
      const [script, keys] = call as [string, string[]];
      expect(script).toContain("if redis.call('SCARD', KEYS[2]) > 0 then");
      expect(script).toContain("return {'oi:persist-guard'}");
      expect(script).toContain('mutation.state ~= \'created\'');
      expect(keys).toEqual([
        'study:study-pending',
        'study-persisting:study-pending',
        'study-mutation-guard:study-pending',
      ]);
    }
  });

  it('Finish is the only mutation allowed to proceed with a live matching guard', async () => {
    const evalMock = vi.fn().mockResolvedValue(['oi:persist-created']);
    const client = { eval: evalMock } as unknown as RedisPort;

    await expect(persistCompletedInterviewFinish(guard, client)).resolves.toEqual({
      status: 'created',
    });
    expect(evalMock.mock.calls[0][1]).toContain('interview-persisting:interview-pending');
    expect(JSON.stringify(guard)).toContain(FINGERPRINT);
    expect(encodePersistingGuard(guard).startsWith('oi:pguard:')).toBe(true);
  });
});
