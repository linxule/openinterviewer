// Operation registry wire parsing (Revision 12 §3, §5).
// P(study-ops:v2) HASH field=studyId, value=`oi:op:`+JSON. HGETALL arrives as
// a string[] of [field, value, …] or as an object of string leaves; HLEN > 100
// makes the Lua caller return ['oi:ops-overflow'] instead of HGETALL.

import { isUuid, ok, UNAVAILABLE, type WireResult } from './types';
import { parsePrefixedJson } from './parse';

export const OPERATION_RECORD_PREFIX = 'oi:op:';
export const OPERATIONS_OVERFLOW = 'oi:ops-overflow';

export interface RegistryRecord {
  studyId: string;
  operation: Record<string, unknown>;
}

/**
 * `oi:op:` + JSON object. Parsers reject `version !== 2` (Revision 12 §6).
 */
export function parseOperationRecord(
  value: unknown
): { ok: true; operation: Record<string, unknown> } | { ok: false } {
  const parsed = parsePrefixedJson(value, OPERATION_RECORD_PREFIX);
  if (!parsed.ok) return { ok: false };
  if (parsed.payload.version !== 2) return { ok: false };
  return { ok: true, operation: parsed.payload };
}

/**
 * Closed HGETALL parser:
 * 1. null / empty array / empty object -> ok with no records.
 * 2. object: every key must match STUDY_ID; every value must be a string
 *    starting with `oi:op:`; reject values the SDK already turned into objects.
 * 3. array: even length; (studyId, oi:op:…) pairs.
 * 4. ['oi:ops-overflow'] -> unavailable.
 */
export function parseRegistryHGetAll(wire: unknown): WireResult<RegistryRecord[]> {
  if (wire === null || wire === undefined) return ok([]);
  if (Array.isArray(wire)) {
    if (wire.length === 0) return ok([]);
    if (wire.length === 1 && wire[0] === OPERATIONS_OVERFLOW) return UNAVAILABLE;
    if (wire.length % 2 !== 0) return UNAVAILABLE;
    const records: RegistryRecord[] = [];
    for (let index = 0; index < wire.length; index += 2) {
      const studyId = wire[index];
      if (typeof studyId !== 'string' || !isUuid(studyId)) return UNAVAILABLE;
      const parsed = parseOperationRecord(wire[index + 1]);
      if (!parsed.ok) return UNAVAILABLE;
      records.push({ studyId, operation: parsed.operation });
    }
    return ok(records);
  }
  if (typeof wire === 'object') {
    const entries = Object.entries(wire as Record<string, unknown>);
    if (entries.length === 0) return ok([]);
    const records: RegistryRecord[] = [];
    for (const [studyId, value] of entries) {
      if (!isUuid(studyId)) return UNAVAILABLE;
      const parsed = parseOperationRecord(value);
      if (!parsed.ok) return UNAVAILABLE;
      records.push({ studyId, operation: parsed.operation });
    }
    records.sort((left, right) => left.studyId.localeCompare(right.studyId));
    return ok(records);
  }
  return UNAVAILABLE;
}
