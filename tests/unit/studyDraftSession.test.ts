import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UUID_V4,
  adoptCreateIdempotencyKey,
  isCreateIntentKey,
  readAuthorityEpoch,
  setupIntentKey,
  writeAuthorityEpoch,
} from '@/lib/studyDraftSession';

/**
 * The browser-session bookkeeping lifted out of StudySetup.tsx (C6): storage
 * keys, the UUID shape, the authority epoch, and the create-key adoption
 * rule. Exercised directly for the first time — previously only through a
 * full component render.
 */

beforeEach(() => {
  sessionStorage.clear();
});

describe('setupIntentKey', () => {
  it('returns edit:<id> when prefill is edit and a study id is present', () => {
    expect(setupIntentKey('edit', 'study-1', null)).toBe('edit:study-1');
  });

  it('returns followup:<parent> when a parent id is present', () => {
    expect(setupIntentKey('followup', null, 'parent-1')).toBe('followup:parent-1');
  });

  it('returns followup with no parent id', () => {
    expect(setupIntentKey('followup', null, null)).toBe('followup');
  });

  it('returns create for every other shape', () => {
    expect(setupIntentKey(null, null, null)).toBe('create');
    expect(setupIntentKey('edit', null, null)).toBe('create');
  });
});

describe('isCreateIntentKey', () => {
  it('accepts create and every followup* variant', () => {
    expect(isCreateIntentKey('create')).toBe(true);
    expect(isCreateIntentKey('followup')).toBe(true);
    expect(isCreateIntentKey('followup:parent-1')).toBe(true);
  });

  it('rejects edit:*', () => {
    expect(isCreateIntentKey('edit:study-1')).toBe(false);
  });
});

describe('readAuthorityEpoch / writeAuthorityEpoch', () => {
  it('returns 0 when absent', () => {
    expect(readAuthorityEpoch()).toBe(0);
  });

  it('returns 0 for a non-numeric stored value', () => {
    sessionStorage.setItem('oi:create-authority-epoch', 'not-a-number');
    expect(readAuthorityEpoch()).toBe(0);
  });

  it('returns 0 for a negative stored value', () => {
    sessionStorage.setItem('oi:create-authority-epoch', '-1');
    expect(readAuthorityEpoch()).toBe(0);
  });

  it('returns 0 for a non-safe-integer stored value', () => {
    sessionStorage.setItem('oi:create-authority-epoch', String(Number.MAX_SAFE_INTEGER + 1));
    expect(readAuthorityEpoch()).toBe(0);
  });

  it('round-trips a written epoch', () => {
    writeAuthorityEpoch(4);
    expect(readAuthorityEpoch()).toBe(4);
  });
});

describe('adoptCreateIdempotencyKey', () => {
  it('mints a fresh UUID v4 when nothing is persisted', () => {
    const key = adoptCreateIdempotencyKey('create', 0);
    expect(UUID_V4.test(key)).toBe(true);
  });

  it('returns the persisted key when intentKey and authorityEpoch both match', () => {
    const first = adoptCreateIdempotencyKey('create', 0);
    const second = adoptCreateIdempotencyKey('create', 0);
    expect(second).toBe(first);
  });

  it('mints a new key when the intent differs', () => {
    const first = adoptCreateIdempotencyKey('create', 0);
    const second = adoptCreateIdempotencyKey('followup:parent-1', 0);
    expect(second).not.toBe(first);
  });

  it('mints a new key when the authority epoch differs', () => {
    const first = adoptCreateIdempotencyKey('create', 0);
    const second = adoptCreateIdempotencyKey('create', 1);
    expect(second).not.toBe(first);
  });

  it('mints a new key when the stored key fails UUID_V4', () => {
    sessionStorage.setItem(
      'oi:create-idempotency-state',
      JSON.stringify({ intentKey: 'create', authorityEpoch: 0, key: 'not-a-uuid' })
    );
    const key = adoptCreateIdempotencyKey('create', 0);
    expect(UUID_V4.test(key)).toBe(true);
    expect(key).not.toBe('not-a-uuid');
  });

  it('does not throw on a corrupt stored value', () => {
    sessionStorage.setItem('oi:create-idempotency-state', '{not json');
    expect(() => adoptCreateIdempotencyKey('create', 0)).not.toThrow();
  });
});

describe('UUID_V4', () => {
  it('matches crypto.randomUUID output', () => {
    const spy = vi.spyOn(crypto, 'randomUUID');
    const key = adoptCreateIdempotencyKey('create', 0);
    expect(spy).toHaveBeenCalled();
    expect(UUID_V4.test(key)).toBe(true);
  });
});
