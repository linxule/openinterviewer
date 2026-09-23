// Shared HTTP translation for /api/operator/* routes. Every response is JSON
// with `Cache-Control: no-store`; every outcome is logged once as an
// allowlisted `operator.action` event without content.
//
// Deployment-readiness gate (gap F10) exemptions, exactly:
//  - GET status, GET backup (reads that diagnose or rescue a held workspace);
//  - POST backup/import and POST recovery/activate (they act only inside the
//    `recovery` hold, which the object enforces);
//  - POST recovery/restore (only inside the `frozen` or `recovery` hold, with
//    the epoch already rotated, so the restored storage stays inert);
//  - POST maintenance whose transition tightens the hold (open → draining,
//    any state → frozen or recovery).
// A maintenance transition that enables more work — to `open`, or to
// `draining` from `frozen`/`recovery` — passes deploymentNotReadyResponse
// first, so a not-ready deployment is never reopened. Operator authority
// (target, OPERATOR_TOKEN, recent session) applies to every call either way.

import type { NextResponse } from 'next/server';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { logRequestFailure, type RequestLogReason } from '@/lib/requestLog';
import {
  logOperatorAction,
  operatorJson,
  operatorRefusal,
  type OperatorRequestLabel,
} from '@/lib/operatorAuth';
import type { MaintenanceState, WorkspaceHoldReason } from '@/lib/storage/types';
import type { OperatorRpcResult } from './workspaceRpc';

export const MAINTENANCE_STATES: ReadonlyArray<MaintenanceState> = ['open', 'draining', 'frozen', 'recovery'];

/**
 * Largest backup import request: one chunk as the exporter wrote it (at most
 * 8 MiB of column bytes per page, plus JSON escaping) and its manifest.
 * Chunks are bound to their manifest descriptors, so the CLI refuses a larger
 * one before sending instead of splitting it. Shared with
 * scripts/cloudflare/operator.mjs, which applies the same bound.
 */
export const MAX_IMPORT_BODY_BYTES = 24 * 1024 * 1024;

export function isMaintenanceState(value: unknown): value is MaintenanceState {
  return typeof value === 'string' && (MAINTENANCE_STATES as ReadonlyArray<string>).includes(value);
}

/** True when a maintenance transition enables work the current state holds back. */
export function transitionResumesWork(expected: MaintenanceState, next: MaintenanceState): boolean {
  if (next === 'open') return true;
  return next === 'draining' && (expected === 'frozen' || expected === 'recovery');
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isCountRecord(value: unknown): value is Record<string, number> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isSafeCount);
}

const HOLD_REASONS: ReadonlyArray<WorkspaceHoldReason> = [
  'maintenance',
  'schema-unsupported',
  'workspace-identity-mismatch',
  'workspace-uninitialized',
  'recovery-epoch-mismatch',
];

const HOLD_LOG_REASON: Record<WorkspaceHoldReason, RequestLogReason> = {
  maintenance: 'maintenance-hold',
  'schema-unsupported': 'schema-unsupported',
  'workspace-identity-mismatch': 'workspace-identity-mismatch',
  'workspace-uninitialized': 'not-configured',
  'recovery-epoch-mismatch': 'epoch-mismatch',
};

/**
 * A held workspace. `reason` uses the public allowlist ('maintenance' or
 * 'workspace-unavailable'); the authenticated operator also gets the exact
 * hold reason, which is needed to choose the next recovery step.
 */
export function heldResponse(label: OperatorRequestLabel, rawReason: unknown): NextResponse {
  const holdReason = (HOLD_REASONS as ReadonlyArray<unknown>).includes(rawReason)
    ? (rawReason as WorkspaceHoldReason)
    : null;
  return operatorRefusal(
    label,
    503,
    {
      error: 'The workspace is held and refused this operation.',
      code: 'WORKSPACE_HELD',
      retryable: false,
      reason: holdReason === 'maintenance' ? 'maintenance' : 'workspace-unavailable',
      holdReason,
    },
    holdReason ? HOLD_LOG_REASON[holdReason] : 'unavailable',
  );
}

export function notConfiguredResponse(label: OperatorRequestLabel): NextResponse {
  return operatorRefusal(
    label,
    503,
    {
      error: 'Workspace storage is not configured for this deployment.',
      code: 'WORKSPACE_NOT_CONFIGURED',
      retryable: false,
    },
    'binding-missing',
  );
}

/** A read that could not be established; repeating it is always safe. */
export function readUnavailableResponse(label: OperatorRequestLabel): NextResponse {
  return operatorRefusal(
    label,
    503,
    { error: 'Workspace storage is temporarily unavailable.', code: 'WORKSPACE_UNAVAILABLE', retryable: true },
    'unavailable',
  );
}

/** A mutation whose outcome is unknown: it may have committed. */
export function outcomeUnknownResponse(label: OperatorRequestLabel, next: string): NextResponse {
  return operatorRefusal(
    label,
    503,
    { error: `The outcome is unknown. ${next}`, code: 'OUTCOME_UNKNOWN', retryable: true },
    'unknown-outcome',
  );
}

/** Shared handling of the non-reply RPC results. */
export function rpcFailureResponse(
  label: OperatorRequestLabel,
  result: Exclude<OperatorRpcResult, { kind: 'reply' }>,
  onFailed: () => NextResponse,
): NextResponse {
  return result.kind === 'not-configured' ? notConfiguredResponse(label) : onFailed();
}

export function badRequest(label: OperatorRequestLabel, error: string): NextResponse {
  return operatorRefusal(label, 400, { error, code: 'INVALID_REQUEST' }, 'invalid');
}

export function conflict(label: OperatorRequestLabel, body: Record<string, unknown>): NextResponse {
  return operatorRefusal(label, 409, body);
}

export function accepted(label: OperatorRequestLabel, body: Record<string, unknown>): NextResponse {
  logOperatorAction(label, 200);
  return operatorJson(body, 200);
}

export function internalFailure(label: OperatorRequestLabel, error: unknown): NextResponse {
  logRequestFailure({ event: 'route.failure', route: label.route, method: label.method, status: 500 }, error);
  logOperatorAction(label, 500);
  return operatorJson({ error: 'Operator request failed.', code: 'INTERNAL' }, 500);
}

function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const [type] = header.split(';');
  return type.trim().toLowerCase() === 'application/json';
}

export type OperatorBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/**
 * A bounded JSON object body. POST requires `Content-Type: application/json`
 * (415), the byte bound (413) and a JSON object whose keys are all allowed
 * (400).
 */
export async function readOperatorBody(
  request: Request,
  label: OperatorRequestLabel,
  maximumBytes: number,
  allowedKeys: ReadonlyArray<string>,
): Promise<OperatorBody> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return {
      ok: false,
      response: operatorRefusal(label, 415, { error: 'Content-Type must be application/json.', code: 'UNSUPPORTED_MEDIA_TYPE' }, 'invalid'),
    };
  }
  const parsed = await readBoundedJsonObject(request, maximumBytes);
  if (!parsed.ok) {
    return {
      ok: false,
      response: parsed.status === 413
        ? operatorRefusal(label, 413, { error: 'Request body is too large.', code: 'BODY_TOO_LARGE' }, 'too-large')
        : badRequest(label, 'Request body must be a JSON object.'),
    };
  }
  const unexpected = Object.keys(parsed.value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    return { ok: false, response: badRequest(label, 'Request body has unexpected fields.') };
  }
  return { ok: true, value: parsed.value };
}
