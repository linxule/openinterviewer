// Closed Redis wire grammar — Revision 12 §3.
// Every Lua family returns a native Redis array with a dedicated parser. No
// bare JSON object leaves, no numeric status tuples, no optional extra
// elements. Unknown tag, truncated array, extra element, coerced number,
// non-array, or unsafe integer -> wrapper status `unavailable` and zero
// further writes in that call.

// ---------------------------------------------------------------------------
// Identifier / value constants (Revision 12 §1)
// ---------------------------------------------------------------------------

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RESEARCHER_ID = /^[A-Za-z0-9-]{1,256}$/;
export const OP_NONCE = /^[0-9a-f]{32}$/;
export const HEX64 = /^[a-f0-9]{64}$/;
export const MAX_STUDY_REVISION = 99_999_999_999_999;
export const MAX_LIVE_OPS = 100;
export const MAX_STUDIES = 1000;
export const MAX_COLLECTION = 1000;

export type StudyOpPhase = 'reserving' | 'pending' | 'resolving' | 'publishing';
export type StudyOperationKind = 'create' | 'delete';

export function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}

export function isResearcherId(value: string): boolean {
  return RESEARCHER_ID.test(value);
}

export function isOpNonce(value: string): boolean {
  return OP_NONCE.test(value);
}

export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

/** Safe non-negative integer expressed as a decimal string. */
export function isSafeDecimalString(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}

export function parseSafeDecimalString(value: string): number | null {
  if (!isSafeDecimalString(value)) return null;
  return Number(value);
}

// ---------------------------------------------------------------------------
// Wire result
// ---------------------------------------------------------------------------

export type WireResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable' };

export const UNAVAILABLE: { status: 'unavailable' } = Object.freeze({ status: 'unavailable' });

export function ok<T>(value: T): WireResult<T> {
  return { status: 'ok', value };
}

// ---------------------------------------------------------------------------
// Families and their closed tag sets. A family parser accepts only that
// family's tags (Revision 12 §3). `arity` is the exact array length; `kind`
// describes the payload validation for 2-element tags.
// ---------------------------------------------------------------------------

export type FamilyName =
  | 'schema-read'
  | 'bootstrap'
  | 'authority'
  | 'begin'
  | 'recover'
  | 'resolve'
  | 'publish'
  | 'credentials'
  | 'account-delete'
  | 'byos-mutation'
  | 'persist'
  | 'idempotency'
  | 'receipt'
  | 'analysis';

export type TagPayloadKind =
  | 'string'    // any non-empty string value leaf
  | 'phase'     // one of the four StudyOpPhase values
  | 'revision'  // oi:revision:<safe decimal>
  | 'count'     // oi:count:<safe decimal>
  | 'json';     // oi:json:<JSON object>

export interface WireTagSpec {
  readonly arity: 1 | 2;
  readonly payloadKind?: TagPayloadKind;
}

export const FAMILY_TAGS: Record<FamilyName, Readonly<Record<string, WireTagSpec>>> = {
  'schema-read': {
    'oi:schema-unavailable': { arity: 1 },
  },
  bootstrap: {
    'oi:bootstrap-unavailable': { arity: 1 },
  },
  authority: {
    'oi:authz-unavailable': { arity: 1 },
    'oi:authz-adel': { arity: 1 },
    'oi:authz-hold': { arity: 1 },
    'oi:authz-noacct': { arity: 1 },
    'oi:authz-allow': { arity: 2, payloadKind: 'string' },
    'oi:authz-deny': { arity: 1 },
    'oi:authz-notfound': { arity: 1 },
    'oi:authz-live': { arity: 2, payloadKind: 'phase' },
    'oi:authz-corrupt': { arity: 1 },
    'oi:authz-mismatch': { arity: 1 },
  },
  begin: {
    'oi:begin-unavailable': { arity: 1 },
    'oi:begin-hold': { arity: 1 },
    'oi:begin-adel': { arity: 1 },
    'oi:begin-noacct': { arity: 1 },
    'oi:begin-bind': { arity: 1 },
    'oi:begin-opquota': { arity: 1 },
    'oi:begin-live': { arity: 1 },
    'oi:begin-replay': { arity: 2, payloadKind: 'string' },
    'oi:begin-studyquota': { arity: 1 },
    'oi:begin-owner': { arity: 1 },
    'oi:begin-notfound': { arity: 1 },
    'oi:begin-started': { arity: 2, payloadKind: 'string' },
  },
  recover: {
    'oi:recover-unavailable': { arity: 1 },
    'oi:recover-phase': { arity: 2, payloadKind: 'phase' },
    'oi:recover-wait': { arity: 1 },
    'oi:recover-ambiguous': { arity: 1 },
  },
  resolve: {
    'oi:resolve-unavailable': { arity: 1 },
    'oi:resolve-publishing': { arity: 2, payloadKind: 'string' },
    'oi:resolve-missing-operation': { arity: 1 },
    'oi:resolve-ambiguous': { arity: 1 },
    'oi:resolve-stale': { arity: 1 },
    'oi:resolve-receipt-cut': { arity: 1 },
    'oi:resolve-corrupt': { arity: 1 },
    'oi:resolve-terminal': { arity: 1 },
  },
  publish: {
    'oi:publish-unavailable': { arity: 1 },
    'oi:publish-stale': { arity: 1 },
    'oi:publish-corrupt': { arity: 1 },
    'oi:publish-published': { arity: 2, payloadKind: 'count' },
    'oi:publish-pruned': { arity: 2, payloadKind: 'count' },
  },
  credentials: {
    'oi:cred-unavailable': { arity: 1 },
  },
  'account-delete': {
    'oi:adel-unavailable': { arity: 1 },
  },
  'byos-mutation': {
    'oi:byos-unavailable': { arity: 1 },
    'oi:not-found': { arity: 1 },
    'oi:invalid': { arity: 1 },
    'oi:conflict': { arity: 2, payloadKind: 'revision' },
    'oi:needs-confirmation': { arity: 2, payloadKind: 'count' },
    'oi:updated': { arity: 2, payloadKind: 'json' },
    'oi:created': { arity: 1 },
    'oi:deleted': { arity: 1 },
    'oi:cancelled': { arity: 1 },
    'oi:still-pending': { arity: 1 },
  },
  persist: {
    'oi:persist-unavailable': { arity: 1 },
    'oi:persist-rate': { arity: 1 },
    'oi:persist-guard': { arity: 1 },
    'oi:persist-created': { arity: 1 },
    'oi:persist-duplicate': { arity: 1 },
    'oi:persist-conflict': { arity: 1 },
    'oi:persist-not-found': { arity: 1 },
    'oi:persist-links': { arity: 1 },
    'oi:persist-revision': { arity: 1 },
    'oi:persist-started': { arity: 1 },
  },
  idempotency: {
    'oi:idemp-unavailable': { arity: 1 },
    'oi:idemp-adel': { arity: 1 },
    'oi:idemp-noacct': { arity: 1 },
    'oi:idemp-reuse': { arity: 1 },
    'oi:idemp-replay': { arity: 2, payloadKind: 'string' },
    'oi:idemp-quota': { arity: 1 },
    'oi:idemp-started': { arity: 2, payloadKind: 'string' },
  },
  receipt: {
    'oi:receipt-unavailable': { arity: 1 },
  },
  analysis: {
    'oi:analysis-unavailable': { arity: 1 },
    'oi:analysis-notfound': { arity: 1 },
    'oi:analysis-busy': { arity: 1 },
    'oi:analysis-done': { arity: 1 },
    'oi:analysis-stale': { arity: 1 },
    'oi:analysis-written': { arity: 1 },
    'oi:analysis-recorded': { arity: 1 },
    'oi:analysis-corrupt': { arity: 1 },
    'oi:analysis-claimed': { arity: 2, payloadKind: 'count' },
  },
};

export function isFamilyTag(family: FamilyName, tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(FAMILY_TAGS[family], tag);
}
