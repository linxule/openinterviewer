// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredStudy } from '../fixtures/models';

const kvMock = vi.hoisted(() => ({ getStudy: vi.fn() }));
vi.mock('@/lib/kv', () => kvMock);

import { loadCanonicalStudy } from '@/lib/canonicalStudy';

beforeEach(() => vi.clearAllMocks());

describe('canonical study validation', () => {
  it('accepts a complete, identity-consistent canonical record', async () => {
    const study = makeStoredStudy({ id: 'study-valid', revision: 2 });
    study.config.id = study.id;
    kvMock.getStudy.mockResolvedValue(study);

    const result = await loadCanonicalStudy({
      kvClient: {} as never,
      tokenStudyId: study.id,
    });

    expect(result).toMatchObject({ ok: true, study: { id: study.id, revision: 2 } });
  });

  it('fails closed on malformed legacy canonical configuration', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const study = makeStoredStudy({ id: 'study-malformed' });
    study.config.id = study.id;
    (study.config as unknown as Record<string, unknown>).aiProvider = 'unknown-provider';
    kvMock.getStudy.mockResolvedValue(study);

    const result = await loadCanonicalStudy({
      kvClient: {} as never,
      tokenStudyId: study.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });
});
