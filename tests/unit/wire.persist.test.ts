// Closed wire family: crash-total BYOS persistence (Revision 12 §3, §14).
// Outcome tags `oi:persist-rate` and `oi:persist-guard`; the family
// unavailable marker `oi:persist-unavailable` maps to wrapper status
// unavailable. Nothing else is accepted.

import { describe, expect, it } from 'vitest';
import { parsePersistResult } from '@/lib/wire/parse';

describe('wire.persist: parsePersistResult', () => {
  it('maps oi:persist-rate to rate-limited', () => {
    expect(parsePersistResult(['oi:persist-rate'])).toEqual({
      status: 'ok',
      value: { outcome: 'rate-limited' },
    });
  });

  it('maps oi:persist-guard to guard', () => {
    expect(parsePersistResult(['oi:persist-guard'])).toEqual({
      status: 'ok',
      value: { outcome: 'guard' },
    });
  });

  it('maps created, duplicate, conflict, and admission tags', () => {
    expect(parsePersistResult(['oi:persist-created'])).toEqual({
      status: 'ok',
      value: { outcome: 'created' },
    });
    expect(parsePersistResult(['oi:persist-duplicate'])).toEqual({
      status: 'ok',
      value: { outcome: 'duplicate' },
    });
    expect(parsePersistResult(['oi:persist-conflict'])).toEqual({
      status: 'ok',
      value: { outcome: 'conflict' },
    });
    expect(parsePersistResult(['oi:persist-not-found'])).toEqual({
      status: 'ok',
      value: { outcome: 'not-found' },
    });
    expect(parsePersistResult(['oi:persist-links'])).toEqual({
      status: 'ok',
      value: { outcome: 'links-disabled' },
    });
    expect(parsePersistResult(['oi:persist-revision'])).toEqual({
      status: 'ok',
      value: { outcome: 'revision-stale' },
    });
    expect(parsePersistResult(['oi:persist-started'])).toEqual({
      status: 'ok',
      value: { outcome: 'started' },
    });
  });

  it('maps the family unavailable marker to unavailable', () => {
    expect(parsePersistResult(['oi:persist-unavailable'])).toEqual({ status: 'unavailable' });
  });

  it('rejects tags owned by other families', () => {
    expect(parsePersistResult(['oi:idemp-quota'])).toEqual({ status: 'unavailable' });
    expect(parsePersistResult(['oi:begin-started', 'oi:op:{}'])).toEqual({ status: 'unavailable' });
  });

  it('rejects unknown tags and extra elements', () => {
    expect(parsePersistResult(['oi:persist-done'])).toEqual({ status: 'unavailable' });
    expect(parsePersistResult(['oi:persist-guard', 'x'])).toEqual({ status: 'unavailable' });
  });

  it('rejects non-array and empty wires', () => {
    expect(parsePersistResult([])).toEqual({ status: 'unavailable' });
    expect(parsePersistResult('oi:persist-guard')).toEqual({ status: 'unavailable' });
    expect(parsePersistResult(null)).toEqual({ status: 'unavailable' });
  });
});
