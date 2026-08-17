// Closed wire family: researcher account records (`oi:account:` prefixed JSON
// leaves) and the account-delete family parser (Revision 12 §3, §6).

import { describe, expect, it } from 'vitest';
import { parseAccountDeleteResult, parsePrefixedJson } from '@/lib/wire/parse';

const ACCOUNT_PREFIX = 'oi:account:';

describe('wire.account: oi:account: prefixed JSON leaves', () => {
  it('parses a canonical account record', () => {
    const record = JSON.stringify({ version: 2, researcherId: 'res-1', createdAt: 1_700_000_000_000 });
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}${record}`, ACCOUNT_PREFIX)).toEqual({
      ok: true,
      payload: { version: 2, researcherId: 'res-1', createdAt: 1_700_000_000_000 },
    });
  });

  it('rejects a leaf the SDK already JSON.parsed into an object', () => {
    expect(parsePrefixedJson({ version: 2, researcherId: 'res-1' }, ACCOUNT_PREFIX)).toEqual({ ok: false });
  });

  it('rejects the wrong prefix', () => {
    expect(parsePrefixedJson('oi:owner:{}', ACCOUNT_PREFIX)).toEqual({ ok: false });
  });

  it('rejects malformed JSON after the prefix', () => {
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}{not-json`, ACCOUNT_PREFIX)).toEqual({ ok: false });
  });

  it('rejects non-object payloads', () => {
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}[1,2]`, ACCOUNT_PREFIX)).toEqual({ ok: false });
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}"str"`, ACCOUNT_PREFIX)).toEqual({ ok: false });
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}42`, ACCOUNT_PREFIX)).toEqual({ ok: false });
    expect(parsePrefixedJson(`${ACCOUNT_PREFIX}null`, ACCOUNT_PREFIX)).toEqual({ ok: false });
  });

  it('rejects null/undefined leaves', () => {
    expect(parsePrefixedJson(null, ACCOUNT_PREFIX)).toEqual({ ok: false });
    expect(parsePrefixedJson(undefined, ACCOUNT_PREFIX)).toEqual({ ok: false });
  });
});

describe('wire.account: account-delete family parser', () => {
  it('maps oi:adel-unavailable to unavailable', () => {
    expect(parseAccountDeleteResult(['oi:adel-unavailable'])).toEqual({ status: 'unavailable' });
  });

  it('rejects extra elements', () => {
    expect(parseAccountDeleteResult(['oi:adel-unavailable', 'x'])).toEqual({ status: 'unavailable' });
  });

  it('rejects unknown tags', () => {
    expect(parseAccountDeleteResult(['oi:adel-gone'])).toEqual({ status: 'unavailable' });
  });

  it('rejects non-arrays and empty arrays', () => {
    expect(parseAccountDeleteResult('oi:adel-unavailable')).toEqual({ status: 'unavailable' });
    expect(parseAccountDeleteResult(null)).toEqual({ status: 'unavailable' });
    expect(parseAccountDeleteResult({ 0: 'oi:adel-unavailable' })).toEqual({ status: 'unavailable' });
    expect(parseAccountDeleteResult([])).toEqual({ status: 'unavailable' });
  });
});
