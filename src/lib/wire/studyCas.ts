// Study CAS tagged results (Revision 12 §3, family `byos-mutation`, T0c.1).

import { ok, UNAVAILABLE, type WireResult } from './types';
import { parseFamilyWire } from './parse';

export type StudyCasOutcome =
  | { outcome: 'not-found' }
  | { outcome: 'invalid' }
  | { outcome: 'conflict'; revision: number }
  | { outcome: 'needs-confirmation'; count: number }
  | { outcome: 'updated'; study: Record<string, unknown> };

/**
 * Maps the tagged array grammar:
 * ['oi:not-found'] -> not-found
 * ['oi:invalid'] -> invalid
 * ['oi:conflict', 'oi:revision:<n>'] -> conflict
 * ['oi:needs-confirmation', 'oi:count:<n>'] -> needs-confirmation
 * ['oi:updated', 'oi:json:<prefixed study>'] -> updated
 * Anything else in this family (including 'oi:byos-unavailable') and any
 * malformed wire -> unavailable.
 */
export function parseStudyCasResult(wire: unknown): WireResult<StudyCasOutcome> {
  const parsed = parseFamilyWire('byos-mutation', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  switch (tag) {
    case 'oi:not-found':
      return ok({ outcome: 'not-found' });
    case 'oi:invalid':
      return ok({ outcome: 'invalid' });
    case 'oi:conflict':
      return ok({ outcome: 'conflict', revision: payload as number });
    case 'oi:needs-confirmation':
      return ok({ outcome: 'needs-confirmation', count: payload as number });
    case 'oi:updated':
      return ok({ outcome: 'updated', study: payload as Record<string, unknown> });
    default:
      return UNAVAILABLE;
  }
}
