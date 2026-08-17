// Closed wire family: operation registry HGETALL parsing and `oi:op:` record
// decoding (Revision 12 §3, §5, §6). HGETALL arrives as a string[] of
// [field, value, …] pairs or as an object of string leaves; HLEN > 100 makes
// the Lua caller return ['oi:ops-overflow'] instead of HGETALL.

import { describe, expect, it } from 'vitest';
import {
  OPERATIONS_OVERFLOW,
  parseOperationRecord,
  parseRegistryHGetAll,
} from '@/lib/wire/registry';

const STUDY_ID = '6f3a0e56-2b4c-4e11-9a50-2b2a1f3c8d99';
const OP_PREFIX = 'oi:op:';

function opRecord(fields: Record<string, unknown>): string {
  return `${OP_PREFIX}${JSON.stringify(fields)}`;
}

const VALID_OPERATION = { version: 2, kind: 'create', phase: 'pending' };

describe('wire.registry: parseOperationRecord', () => {
  it('decodes a version 2 operation record', () => {
    expect(parseOperationRecord(opRecord(VALID_OPERATION))).toEqual({
      ok: true,
      operation: VALID_OPERATION,
    });
  });

  it('rejects version !== 2 (v1 records are not the contract)', () => {
    expect(parseOperationRecord(opRecord({ version: 1, kind: 'create' }))).toEqual({ ok: false });
    expect(parseOperationRecord(opRecord({ kind: 'create' }))).toEqual({ ok: false });
  });

  it('rejects non-string values (SDK already parsed) and wrong prefixes', () => {
    expect(parseOperationRecord(VALID_OPERATION)).toEqual({ ok: false });
    expect(parseOperationRecord('oi:owner:{}')).toEqual({ ok: false });
    expect(parseOperationRecord('{not-json')).toEqual({ ok: false });
  });
});

describe('wire.registry: parseRegistryHGetAll', () => {
  it('treats null, empty array, and empty object as empty registries', () => {
    expect(parseRegistryHGetAll(null)).toEqual({ status: 'ok', value: [] });
    expect(parseRegistryHGetAll([])).toEqual({ status: 'ok', value: [] });
    expect(parseRegistryHGetAll({})).toEqual({ status: 'ok', value: [] });
  });

  it('parses the array [field, value, …] form', () => {
    const second = '9b1f0d24-7a3e-4b56-8c21-0d4e5f6a7b8c';
    const result = parseRegistryHGetAll([
      STUDY_ID,
      opRecord(VALID_OPERATION),
      second,
      opRecord({ version: 2, kind: 'delete', phase: 'publishing' }),
    ]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toEqual({ studyId: STUDY_ID, operation: VALID_OPERATION });
  });

  it('parses the object-of-string-leaves form', () => {
    const result = parseRegistryHGetAll({ [STUDY_ID]: opRecord(VALID_OPERATION) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual([{ studyId: STUDY_ID, operation: VALID_OPERATION }]);
  });

  it('rejects an odd-length array (truncated pair)', () => {
    expect(parseRegistryHGetAll([STUDY_ID])).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll([STUDY_ID, opRecord(VALID_OPERATION), STUDY_ID])).toEqual({
      status: 'unavailable',
    });
  });

  it('rejects non-UUID fields', () => {
    expect(parseRegistryHGetAll(['not-a-uuid', opRecord(VALID_OPERATION)])).toEqual({
      status: 'unavailable',
    });
    expect(parseRegistryHGetAll({ 'not-a-uuid': opRecord(VALID_OPERATION) })).toEqual({
      status: 'unavailable',
    });
  });

  it('rejects malformed or wrong-prefix values in both forms', () => {
    expect(parseRegistryHGetAll([STUDY_ID, 'oi:op:not-json'])).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll([STUDY_ID, 'oi:owner:{}'])).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll({ [STUDY_ID]: VALID_OPERATION })).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll([STUDY_ID, null])).toEqual({ status: 'unavailable' });
  });

  it('rejects v1 records inside the registry', () => {
    expect(parseRegistryHGetAll([STUDY_ID, opRecord({ version: 1, kind: 'create' })])).toEqual({
      status: 'unavailable',
    });
  });

  it('maps the HLEN-overflow sentinel to unavailable', () => {
    expect(parseRegistryHGetAll([OPERATIONS_OVERFLOW])).toEqual({ status: 'unavailable' });
  });

  it('rejects scalar wires', () => {
    expect(parseRegistryHGetAll('oi:op:{}')).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll(42)).toEqual({ status: 'unavailable' });
    expect(parseRegistryHGetAll(true)).toEqual({ status: 'unavailable' });
  });
});
