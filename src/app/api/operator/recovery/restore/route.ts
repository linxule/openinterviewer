// POST /api/operator/recovery/restore — schedule a point-in-time restore of
// the workspace object (OPS-03 step 4). Body: { expectedState,
// expectedVersion, bookmark } or { expectedState, expectedVersion, at } with
// `at` in epoch milliseconds inside the platform's 30-day window. The object
// refuses unless it is `frozen` or `recovery` at exactly that state and
// version and the deployment's configured recovery epoch was already rotated
// away from the activated one (step 3). It then resolves the time to a
// bookmark, schedules the restore for its next session, replies and restarts;
// nothing is written, and the decision is logged without content. Cloudflare
// target only; operator authority required; exempt from the
// deployment-readiness gate (see ../../_lib/http.ts).
//
//   200 scheduled { bookmark, undoBookmark } (restoring undoBookmark reverses it)
//   409 MAINTENANCE_CONFLICT (with the current state/version) | NOT_HELD | EPOCH_NOT_ROTATED
//   422 BOOKMARK_REFUSED (the platform refused the time or bookmark; nothing scheduled)
//   503 WORKSPACE_HELD | OUTCOME_UNKNOWN (read status before retrying)

export const dynamic = 'force-dynamic';

import { operatorAuthorityRefusal, operatorRefusal, type OperatorRequestLabel } from '@/lib/operatorAuth';
import { isRestoreBookmark, RESTORE_WINDOW_MS } from '@/lib/storage/types';
import {
  accepted,
  badRequest,
  conflict,
  heldResponse,
  internalFailure,
  isMaintenanceState,
  isSafeCount,
  outcomeUnknownResponse,
  readOperatorBody,
  rpcFailureResponse,
} from '../../_lib/http';
import { callOperatorRpc } from '../../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/recovery/restore', method: 'POST', operation: 'recovery.restore' };
const MAX_BODY_BYTES = 1024;
const READ_STATUS_FIRST = 'Read status: once the object restarts it reports the restored maintenance state and version.';

export async function POST(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const body = await readOperatorBody(request, LABEL, MAX_BODY_BYTES, ['expectedState', 'expectedVersion', 'bookmark', 'at']);
    if (!body.ok) return body.response;
    const { expectedState, expectedVersion, bookmark, at } = body.value;
    if (!isMaintenanceState(expectedState)) {
      return badRequest(LABEL, 'expectedState must be the state status reports (frozen or recovery).');
    }
    if (!isSafeCount(expectedVersion)) return badRequest(LABEL, 'expectedVersion must be a non-negative integer.');
    if ((bookmark === undefined) === (at === undefined)) {
      return badRequest(LABEL, 'Name exactly one of bookmark and at.');
    }
    if (bookmark !== undefined && !isRestoreBookmark(bookmark)) {
      return badRequest(LABEL, 'bookmark must be a point-in-time recovery bookmark.');
    }
    const now = Date.now();
    if (at !== undefined && (!isSafeCount(at) || at > now || at < now - RESTORE_WINDOW_MS)) {
      return badRequest(LABEL, 'at must be a past time in epoch milliseconds within the last 30 days.');
    }

    const result = await callOperatorRpc('restoreToBookmark', {
      expectedState,
      expectedVersion,
      bookmark: bookmark ?? null,
      at: at ?? null,
      now,
    });
    if (result.kind !== 'reply') {
      return rpcFailureResponse(LABEL, result, () => outcomeUnknownResponse(LABEL, READ_STATUS_FIRST));
    }
    const { reply } = result;
    switch (reply.status) {
      case 'scheduled':
        if (!isRestoreBookmark(reply.bookmark) || !isRestoreBookmark(reply.undoBookmark)) break;
        return accepted(LABEL, { status: 'scheduled', bookmark: reply.bookmark, undoBookmark: reply.undoBookmark });
      case 'conflict':
        if (!isMaintenanceState(reply.state) || !isSafeCount(reply.version)) break;
        return conflict(LABEL, {
          error: 'The workspace is not in the expected state and version.',
          code: 'MAINTENANCE_CONFLICT',
          state: reply.state,
          version: reply.version,
        });
      case 'not-held':
        if (!isMaintenanceState(reply.state) || !isSafeCount(reply.version)) break;
        return conflict(LABEL, {
          error: 'A restore runs only while the workspace is frozen or in recovery.',
          code: 'NOT_HELD',
          state: reply.state,
          version: reply.version,
        });
      case 'epoch-not-rotated':
        return conflict(LABEL, {
          error: 'Bind a new ANALYSIS_RECOVERY_EPOCH secret before restoring: the configured epoch must be valid, '
            + 'differ from the activated one and never have been activated here.',
          code: 'EPOCH_NOT_ROTATED',
        });
      case 'bookmark-refused':
        return operatorRefusal(LABEL, 422, {
          error: 'The platform refused the time or bookmark. Nothing was scheduled.',
          code: 'BOOKMARK_REFUSED',
          retryable: false,
        }, 'invalid');
      case 'invalid-request':
        return badRequest(LABEL, 'The restore request is invalid.');
      case 'held':
        return heldResponse(LABEL, reply.reason);
      default:
        break;
    }
    return outcomeUnknownResponse(LABEL, READ_STATUS_FIRST);
  } catch (error) {
    return internalFailure(LABEL, error);
  }
}
