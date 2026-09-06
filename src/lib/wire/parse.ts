// Wire parsing engine (Revision 12 §3, §6).
// A family parser accepts only that family's tags. Unknown tag, truncated
// array, extra element, coerced number, non-array, or unsafe integer maps to
// wrapper status `unavailable` with zero further writes in that call.

import {
  FAMILY_TAGS,
  isOpNonce,
  isResearcherId,
  isSafeDecimalString,
  ok,
  parseSafeDecimalString,
  UNAVAILABLE,
  WireResult,
  type FamilyName,
  type StudyOpPhase,
  type StudyOperationKind,
} from './types';

const STUDY_OP_PHASES: readonly string[] = ['reserving', 'pending', 'resolving', 'publishing'];

export type DecodedPayload = string | number | Record<string, unknown>;

export interface ParsedFamilyValue {
  tag: string;
  payload?: DecodedPayload;
}

/**
 * Core engine: validates that `wire` is a native Redis array whose first
 * element is a string tag owned by `family`, with the exact fixed arity and a
 * non-coerced, well-formed payload.
 */
export function parseFamilyWire(
  family: FamilyName,
  wire: unknown
): WireResult<ParsedFamilyValue> {
  if (!Array.isArray(wire) || wire.length === 0) return UNAVAILABLE;
  const tag = wire[0];
  if (typeof tag !== 'string') return UNAVAILABLE;
  const spec = FAMILY_TAGS[family][tag];
  if (!spec) return UNAVAILABLE;
  if (wire.length !== spec.arity) return UNAVAILABLE;
  if (spec.arity === 1) return ok({ tag });

  const rawPayload = wire[1];
  if (typeof rawPayload !== 'string') return UNAVAILABLE;
  switch (spec.payloadKind) {
    case 'string':
      if (rawPayload.length === 0) return UNAVAILABLE;
      return ok({ tag, payload: rawPayload });
    case 'phase': {
      if (!STUDY_OP_PHASES.includes(rawPayload)) return UNAVAILABLE;
      return ok({ tag, payload: rawPayload });
    }
    case 'revision': {
      const revision = parsePrefixedDecimal(rawPayload, 'oi:revision:');
      if (revision === null) return UNAVAILABLE;
      return ok({ tag, payload: revision });
    }
    case 'count': {
      const count = parsePrefixedDecimal(rawPayload, 'oi:count:');
      if (count === null) return UNAVAILABLE;
      return ok({ tag, payload: count });
    }
    case 'json': {
      if (!rawPayload.startsWith('oi:json:')) return UNAVAILABLE;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawPayload.slice('oi:json:'.length));
      } catch {
        return UNAVAILABLE;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return UNAVAILABLE;
      return ok({ tag, payload: parsed as Record<string, unknown> });
    }
    default:
      return UNAVAILABLE;
  }
}

function parsePrefixedDecimal(value: string, prefix: string): number | null {
  if (!value.startsWith(prefix)) return null;
  return parseSafeDecimalString(value.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Prefixed JSON leaves. Installed @upstash/redis recursively JSON.parses
// string leaves, so parsers require the value to be a string starting with
// the exact prefix and reject already-parsed objects / coerced numbers.
// ---------------------------------------------------------------------------

export function parsePrefixedJson(
  value: unknown,
  prefix: string
): { ok: true; payload: Record<string, unknown> } | { ok: false } {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(prefix.length));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  return { ok: true, payload: parsed as Record<string, unknown> };
}

export function parsePrefixedHex(
  value: unknown,
  prefix: string,
  hexLength: number
): string | null {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length);
  if (hex.length !== hexLength || !/^[a-f0-9]+$/.test(hex)) return null;
  return hex;
}

// ---------------------------------------------------------------------------
// Lock value grammar (Revision 12 §6): oi:lock:{generation}:{researcherId}:
// {kind}:{opNonce} — exactly 6 parts, no JSON.
// ---------------------------------------------------------------------------

export interface ParsedLockValue {
  generation: number;
  researcherId: string;
  kind: StudyOperationKind;
  opNonce: string;
}

export const MAX_GENERATION = 2_147_483_647;

export function parseLockValue(value: unknown): ParsedLockValue | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 6 || parts[0] !== 'oi' || parts[1] !== 'lock') return null;
  if (!isSafeDecimalString(parts[2])) return null;
  const generation = Number(parts[2]);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) return null;
  if (!isResearcherId(parts[3])) return null;
  if (parts[4] !== 'create' && parts[4] !== 'delete') return null;
  if (!isOpNonce(parts[5])) return null;
  return { generation, researcherId: parts[3], kind: parts[4], opNonce: parts[5] };
}

// ---------------------------------------------------------------------------
// Typed per-family result parsers. Each accepts only its own family's tags.
// ---------------------------------------------------------------------------

export type BeginWireOutcome =
  | { outcome: 'started'; value: string }
  | { outcome: 'replay'; value: string }
  | {
      outcome:
        | 'hold'
        | 'adel'
        | 'noacct'
        | 'bind'
        | 'opquota'
        | 'live'
        | 'studyquota'
        | 'owner'
        | 'notfound';
    };

type BeginSimpleOutcome = Exclude<BeginWireOutcome['outcome'], 'started' | 'replay'>;

const BEGIN_SIMPLE: Record<string, BeginSimpleOutcome> = {
  'oi:begin-hold': 'hold',
  'oi:begin-adel': 'adel',
  'oi:begin-noacct': 'noacct',
  'oi:begin-bind': 'bind',
  'oi:begin-opquota': 'opquota',
  'oi:begin-live': 'live',
  'oi:begin-studyquota': 'studyquota',
  'oi:begin-owner': 'owner',
  'oi:begin-notfound': 'notfound',
};

export function parseBeginResult(wire: unknown): WireResult<BeginWireOutcome> {
  const parsed = parseFamilyWire('begin', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  if (tag === 'oi:begin-started') return ok({ outcome: 'started', value: payload as string });
  if (tag === 'oi:begin-replay') return ok({ outcome: 'replay', value: payload as string });
  const outcome = BEGIN_SIMPLE[tag];
  if (!outcome) return UNAVAILABLE;
  return ok({ outcome });
}

export type RecoverWireOutcome =
  | { outcome: 'phase'; phase: StudyOpPhase }
  | { outcome: 'wait' }
  | { outcome: 'ambiguous' };

export function parseRecoverResult(wire: unknown): WireResult<RecoverWireOutcome> {
  const parsed = parseFamilyWire('recover', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  if (tag === 'oi:recover-phase') {
    return ok({ outcome: 'phase', phase: payload as StudyOpPhase });
  }
  if (tag === 'oi:recover-wait') return ok({ outcome: 'wait' });
  if (tag === 'oi:recover-ambiguous') return ok({ outcome: 'ambiguous' });
  return UNAVAILABLE;
}

export type ResolveWireOutcome =
  | { outcome: 'publishing'; value: string }
  | {
      outcome:
        | 'missing-operation'
        | 'ambiguous'
        | 'stale'
        | 'receipt-cut'
        | 'corrupt'
        | 'terminal';
    };

type ResolveSimpleOutcome = Exclude<ResolveWireOutcome['outcome'], 'publishing'>;

const RESOLVE_SIMPLE: Record<string, ResolveSimpleOutcome> = {
  'oi:resolve-missing-operation': 'missing-operation',
  'oi:resolve-ambiguous': 'ambiguous',
  'oi:resolve-stale': 'stale',
  'oi:resolve-receipt-cut': 'receipt-cut',
  'oi:resolve-corrupt': 'corrupt',
  'oi:resolve-terminal': 'terminal',
};

export function parseResolveResult(wire: unknown): WireResult<ResolveWireOutcome> {
  const parsed = parseFamilyWire('resolve', wire);
  if (parsed.status !== 'ok') return parsed;
  if (parsed.value.tag === 'oi:resolve-publishing') {
    return ok({ outcome: 'publishing', value: parsed.value.payload as string });
  }
  const outcome = RESOLVE_SIMPLE[parsed.value.tag];
  if (!outcome) return UNAVAILABLE;
  return ok({ outcome });
}

export type PublishWireOutcome =
  | { outcome: 'published'; count: number }
  | { outcome: 'pruned'; count: number }
  | { outcome: 'stale' }
  | { outcome: 'corrupt' };

export function parsePublishResult(wire: unknown): WireResult<PublishWireOutcome> {
  const parsed = parseFamilyWire('publish', wire);
  if (parsed.status !== 'ok') return parsed;
  if (parsed.value.tag === 'oi:publish-published') {
    return ok({ outcome: 'published', count: parsed.value.payload as number });
  }
  if (parsed.value.tag === 'oi:publish-pruned') {
    return ok({ outcome: 'pruned', count: parsed.value.payload as number });
  }
  if (parsed.value.tag === 'oi:publish-stale') return ok({ outcome: 'stale' });
  if (parsed.value.tag === 'oi:publish-corrupt') return ok({ outcome: 'corrupt' });
  return UNAVAILABLE;
}

export type AuthorityWireOutcome =
  | { outcome: 'account-deleting' }
  | { outcome: 'hold' | 'noacct' | 'deny' | 'notfound' | 'corrupt' | 'mismatch' }
  | { outcome: 'allow'; value: string }
  | { outcome: 'live'; phase: StudyOpPhase };

export function parseAuthorityResult(wire: unknown): WireResult<AuthorityWireOutcome> {
  const parsed = parseFamilyWire('authority', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  if (tag === 'oi:authz-adel') return ok({ outcome: 'account-deleting' });
  if (tag === 'oi:authz-hold') return ok({ outcome: 'hold' });
  if (tag === 'oi:authz-noacct') return ok({ outcome: 'noacct' });
  if (tag === 'oi:authz-deny') return ok({ outcome: 'deny' });
  if (tag === 'oi:authz-notfound') return ok({ outcome: 'notfound' });
  if (tag === 'oi:authz-corrupt') return ok({ outcome: 'corrupt' });
  if (tag === 'oi:authz-mismatch') return ok({ outcome: 'mismatch' });
  if (tag === 'oi:authz-allow') return ok({ outcome: 'allow', value: payload as string });
  if (tag === 'oi:authz-live') return ok({ outcome: 'live', phase: payload as StudyOpPhase });
  return UNAVAILABLE;
}

export type PersistWireOutcome =
  | { outcome: 'rate-limited' }
  | { outcome: 'guard' }
  | { outcome: 'created' }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict' }
  | { outcome: 'not-found' }
  | { outcome: 'links-disabled' }
  | { outcome: 'revision-stale' }
  | { outcome: 'started' };

const PERSIST_OUTCOMES: Record<string, PersistWireOutcome['outcome']> = {
  'oi:persist-rate': 'rate-limited',
  'oi:persist-guard': 'guard',
  'oi:persist-created': 'created',
  'oi:persist-duplicate': 'duplicate',
  'oi:persist-conflict': 'conflict',
  'oi:persist-not-found': 'not-found',
  'oi:persist-links': 'links-disabled',
  'oi:persist-revision': 'revision-stale',
  'oi:persist-started': 'started',
};

export function parsePersistResult(wire: unknown): WireResult<PersistWireOutcome> {
  const parsed = parseFamilyWire('persist', wire);
  if (parsed.status !== 'ok') return parsed;
  const outcome = PERSIST_OUTCOMES[parsed.value.tag];
  if (!outcome) return UNAVAILABLE;
  return ok({ outcome });
}

export type IdempotencyWireOutcome =
  | { outcome: 'adel' | 'noacct' | 'reuse' | 'quota' }
  | { outcome: 'replay'; value: string }
  | { outcome: 'started'; value: string };

export function parseIdempotencyResult(wire: unknown): WireResult<IdempotencyWireOutcome> {
  const parsed = parseFamilyWire('idempotency', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  if (tag === 'oi:idemp-adel') return ok({ outcome: 'adel' });
  if (tag === 'oi:idemp-noacct') return ok({ outcome: 'noacct' });
  if (tag === 'oi:idemp-reuse') return ok({ outcome: 'reuse' });
  if (tag === 'oi:idemp-quota') return ok({ outcome: 'quota' });
  if (tag === 'oi:idemp-replay') return ok({ outcome: 'replay', value: payload as string });
  if (tag === 'oi:idemp-started') return ok({ outcome: 'started', value: payload as string });
  return UNAVAILABLE;
}

/**
 * Families whose only defined tags are their unavailable markers. Any input
 * maps to `unavailable`; later phases extend the tag tables for outcome tags.
 */
function unavailableOnlyFamily(family: FamilyName, wire: unknown): WireResult<never> {
  const parsed = parseFamilyWire(family, wire);
  return parsed.status === 'ok' ? UNAVAILABLE : parsed;
}

export function parseSchemaReadResult(wire: unknown): WireResult<never> {
  return unavailableOnlyFamily('schema-read', wire);
}

export function parseBootstrapResult(wire: unknown): WireResult<never> {
  return unavailableOnlyFamily('bootstrap', wire);
}

export function parseCredentialsResult(wire: unknown): WireResult<never> {
  return unavailableOnlyFamily('credentials', wire);
}

export function parseAccountDeleteResult(wire: unknown): WireResult<never> {
  return unavailableOnlyFamily('account-delete', wire);
}

export function parseReceiptResult(wire: unknown): WireResult<never> {
  return unavailableOnlyFamily('receipt', wire);
}

export type AnalysisWireOutcome =
  | { outcome: 'notfound' | 'busy' | 'done' | 'stale' | 'written' | 'recorded' }
  | { outcome: 'claimed'; attempts: number };

const ANALYSIS_SIMPLE: Record<string, Exclude<AnalysisWireOutcome['outcome'], 'claimed'>> = {
  'oi:analysis-notfound': 'notfound',
  'oi:analysis-busy': 'busy',
  'oi:analysis-done': 'done',
  'oi:analysis-stale': 'stale',
  'oi:analysis-written': 'written',
  'oi:analysis-recorded': 'recorded',
};

export function parseAnalysisResult(wire: unknown): WireResult<AnalysisWireOutcome> {
  const parsed = parseFamilyWire('analysis', wire);
  if (parsed.status !== 'ok') return parsed;
  const { tag, payload } = parsed.value;
  if (tag === 'oi:analysis-claimed') {
    if (typeof payload !== 'number' || payload < 1) return UNAVAILABLE;
    return ok({ outcome: 'claimed', attempts: payload });
  }
  const outcome = ANALYSIS_SIMPLE[tag];
  if (!outcome) return UNAVAILABLE;
  return ok({ outcome });
}
