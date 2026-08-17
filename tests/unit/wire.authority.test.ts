// Closed wire family: platform authority script (Revision 12 §3, §10).

import { describe, expect, it } from 'vitest';
import { parseAuthorityResult } from '@/lib/wire/parse';

describe('wire.authority: parseAuthorityResult', () => {
  it('maps oi:authz-adel to account-deleting', () => {
    expect(parseAuthorityResult(['oi:authz-adel'])).toEqual({
      status: 'ok',
      value: { outcome: 'account-deleting' },
    });
  });

  it('maps allow, live, and closed refusal tags', () => {
    expect(parseAuthorityResult(['oi:authz-allow', 'oi:owner:{"version":2}'])).toEqual({
      status: 'ok',
      value: { outcome: 'allow', value: 'oi:owner:{"version":2}' },
    });
    expect(parseAuthorityResult(['oi:authz-live', 'pending'])).toEqual({
      status: 'ok',
      value: { outcome: 'live', phase: 'pending' },
    });
    expect(parseAuthorityResult(['oi:authz-hold'])).toEqual({ status: 'ok', value: { outcome: 'hold' } });
    expect(parseAuthorityResult(['oi:authz-noacct'])).toEqual({ status: 'ok', value: { outcome: 'noacct' } });
    expect(parseAuthorityResult(['oi:authz-deny'])).toEqual({ status: 'ok', value: { outcome: 'deny' } });
    expect(parseAuthorityResult(['oi:authz-notfound'])).toEqual({ status: 'ok', value: { outcome: 'notfound' } });
    expect(parseAuthorityResult(['oi:authz-corrupt'])).toEqual({ status: 'ok', value: { outcome: 'corrupt' } });
    expect(parseAuthorityResult(['oi:authz-mismatch'])).toEqual({ status: 'ok', value: { outcome: 'mismatch' } });
  });

  it('maps the family unavailable marker to unavailable', () => {
    expect(parseAuthorityResult(['oi:authz-unavailable'])).toEqual({ status: 'unavailable' });
  });

  it('rejects tags owned by other families', () => {
    expect(parseAuthorityResult(['oi:begin-hold'])).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(['oi:persist-rate'])).toEqual({ status: 'unavailable' });
  });

  it('rejects unknown tags', () => {
    expect(parseAuthorityResult(['oi:authz-deny-now'])).toEqual({ status: 'unavailable' });
  });

  it('rejects extra elements and payloads on an arity-1 tag', () => {
    expect(parseAuthorityResult(['oi:authz-adel', 'x'])).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(['oi:authz-adel', 5])).toEqual({ status: 'unavailable' });
  });

  it('rejects truncated, non-array, and empty wires', () => {
    expect(parseAuthorityResult([])).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult('oi:authz-adel')).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(null)).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(undefined)).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult({ 0: 'oi:authz-adel' })).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(7)).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(['oi:authz-allow'])).toEqual({ status: 'unavailable' });
    expect(parseAuthorityResult(['oi:authz-live', 'not-a-phase'])).toEqual({ status: 'unavailable' });
  });
});
