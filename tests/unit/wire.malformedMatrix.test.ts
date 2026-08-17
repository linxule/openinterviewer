// Closed wire grammar malformed matrix (Revision 12 §3, §20): every family,
// every tag. Unknown tag, truncated array, extra element, coerced number,
// non-array, unsafe integer, malformed JSON leaf, or empty payload -> wrapper
// status `unavailable` with zero further writes. Family tags are never shared
// between parsers.

import { describe, expect, it } from 'vitest';
import { parseFamilyWire } from '@/lib/wire/parse';
import { FAMILY_TAGS, type FamilyName, type TagPayloadKind } from '@/lib/wire/types';

const FAMILY_NAMES = Object.keys(FAMILY_TAGS) as FamilyName[];

function payloadFor(kind: TagPayloadKind | undefined, tag: string): string {
  switch (kind) {
    case 'string':
      return 'oi:op:{"version":2}';
    case 'phase':
      return 'reserving';
    case 'revision':
      return 'oi:revision:7';
    case 'count':
      return 'oi:count:3';
    case 'json':
      return 'oi:json:{"revision":2}';
    default:
      throw new Error(`no payload fixture for ${tag}`);
  }
}

describe('wire.malformedMatrix: every family rejects every closed-grammar violation', () => {
  for (const family of FAMILY_NAMES) {
    const tags = Object.keys(FAMILY_TAGS[family]);

    it(`[${family}] accepts its own valid tagged arrays`, () => {
      for (const tag of tags) {
        const spec = FAMILY_TAGS[family][tag];
        const wire = spec.arity === 1 ? [tag] : [tag, payloadFor(spec.payloadKind, tag)];
        expect(parseFamilyWire(family, wire).status, `wire=${JSON.stringify(wire)}`).toBe('ok');
      }
    });

    it(`[${family}] rejects non-arrays and empty arrays`, () => {
      for (const wire of ['oi:x', null, undefined, 42, {}, true, []]) {
        expect(parseFamilyWire(family, wire).status, `wire=${JSON.stringify(wire)}`).toBe(
          'unavailable'
        );
      }
    });

    it(`[${family}] rejects unknown tags`, () => {
      expect(parseFamilyWire(family, ['oi:totally-unknown']).status).toBe('unavailable');
    });

    it(`[${family}] rejects tags owned by other families (no shared parsers)`, () => {
      for (const other of FAMILY_NAMES) {
        if (other === family) continue;
        for (const otherTag of Object.keys(FAMILY_TAGS[other])) {
          const spec = FAMILY_TAGS[other][otherTag];
          const wire = spec.arity === 1 ? [otherTag] : [otherTag, payloadFor(spec.payloadKind, otherTag)];
          expect(
            parseFamilyWire(family, wire).status,
            `family=${family} wire=${JSON.stringify(wire)}`
          ).toBe('unavailable');
        }
      }
    });

    for (const tag of tags) {
      const spec = FAMILY_TAGS[family][tag];
      const payload = spec.arity === 2 ? payloadFor(spec.payloadKind, tag) : undefined;

      if (spec.arity === 2) {
        it(`[${family}] ${tag} rejects a truncated array`, () => {
          expect(parseFamilyWire(family, [tag]).status).toBe('unavailable');
        });
      }

      it(`[${family}] ${tag} rejects an extra element`, () => {
        const wire = spec.arity === 1 ? [tag, 'x'] : [tag, payload, payload];
        expect(parseFamilyWire(family, wire).status).toBe('unavailable');
      });

      it(`[${family}] ${tag} rejects a coerced number payload`, () => {
        const wire = [tag, 5];
        expect(parseFamilyWire(family, wire).status).toBe('unavailable');
      });

      if (spec.arity === 2) {
        it(`[${family}] ${tag} rejects a non-string payload`, () => {
          expect(parseFamilyWire(family, [tag, { raw: payload }]).status).toBe('unavailable');
          expect(parseFamilyWire(family, [tag, null]).status).toBe('unavailable');
        });

        it(`[${family}] ${tag} rejects an empty payload`, () => {
          expect(parseFamilyWire(family, [tag, '']).status).toBe('unavailable');
        });

        if (spec.payloadKind === 'revision') {
          it(`[${family}] ${tag} rejects malformed, coerced, and unsafe revisions`, () => {
            for (const bad of [
              'oi:revision:abc',
              'oi:revision:1.5',
              'oi:revision:-1',
              'oi:revision:9007199254740992',
              'oi:revision:+3',
              'oi:revision:',
              'oi:count:7',
              'revision:7',
            ]) {
              expect(parseFamilyWire(family, [tag, bad]).status, `payload=${bad}`).toBe(
                'unavailable'
              );
            }
          });
        }

        if (spec.payloadKind === 'count') {
          it(`[${family}] ${tag} rejects malformed, coerced, and unsafe counts`, () => {
            for (const bad of [
              'oi:count:abc',
              'oi:count:2.5',
              'oi:count:-1',
              'oi:count:9007199254740992',
              'oi:count:',
              'oi:revision:7',
            ]) {
              expect(parseFamilyWire(family, [tag, bad]).status, `payload=${bad}`).toBe(
                'unavailable'
              );
            }
          });
        }

        if (spec.payloadKind === 'phase') {
          it(`[${family}] ${tag} rejects unknown phases`, () => {
            for (const bad of ['reserved', 'PENDING', 'reserving ', 'cancelled']) {
              expect(parseFamilyWire(family, [tag, bad]).status, `payload=${bad}`).toBe(
                'unavailable'
              );
            }
          });
        }

        if (spec.payloadKind === 'json') {
          it(`[${family}] ${tag} rejects malformed or non-object JSON leaves`, () => {
            for (const bad of [
              'oi:json:{not-json',
              'oi:json:"a string"',
              'oi:json:42',
              'oi:json:[1,2]',
              'oi:json:null',
              'oi:json',
              'oi:json:',
              '{"revision":2}',
            ]) {
              expect(parseFamilyWire(family, [tag, bad]).status, `payload=${bad}`).toBe(
                'unavailable'
              );
            }
          });
        }

        if (spec.payloadKind === 'string') {
          it(`[${family}] ${tag} accepts non-empty opaque strings at the grammar level`, () => {
            // Prefix/JSON shape validation is the family wrapper's job, not
            // the closed grammar's; only emptiness and coercion are grammar
            // violations.
            for (const good of ['raw-value', 'oi:op:{"version":2}', 'any-letters']) {
              expect(parseFamilyWire(family, [tag, good]).status, `payload=${good}`).toBe('ok');
            }
          });
        }
      }
    }
  }
});
