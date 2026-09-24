// GET /api/operator/backup?family=&cursor=&watermark= — one operational
// backup page (OPS-02). The operator CLI assembles pages into format-v1
// chunk files, a manifest and a completion trailer (src/lib/backup/format.ts).
// `watermark` is `<maintenanceVersion>:<mutationSeq>` from the first page;
// omit it only for the first page. A later page (one with a cursor) without
// it is refused (400), so the object checks every later page against it.
// Cloudflare target only; operator authority required; exempt from the
// deployment-readiness gate (see ../_lib/http.ts).
//
//   200 { status:'ok', watermark, family, rows, nextCursor, families, schemaVersion, workspaceId }
//   409 NOT_FROZEN | WATERMARK_CHANGED
//   503 WORKSPACE_HELD | WORKSPACE_UNAVAILABLE

export const dynamic = 'force-dynamic';

import { BACKUP_FAMILY_NAMES, BACKUP_MAX_CHUNK_ROWS } from '@/lib/backup/format';
import { operatorAuthorityRefusal, type OperatorRequestLabel } from '@/lib/operatorAuth';
import {
  accepted,
  badRequest,
  conflict,
  heldResponse,
  internalFailure,
  isSafeCount,
  readUnavailableResponse,
  rpcFailureResponse,
} from '../_lib/http';
import { callOperatorRpc, type OperatorReply } from '../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/backup', method: 'GET', operation: 'backup.export' };
const MAX_CURSOR_LENGTH = 4096;
const ALLOWED_PARAMS = new Set(['family', 'cursor', 'watermark']);
const WATERMARK = /^(\d{1,16}):(\d{1,16})$/;

type Watermark = { maintenanceVersion: number; mutationSeq: number };

function parseWatermark(raw: string | null): Watermark | null | 'invalid' {
  if (raw === null) return null;
  const match = WATERMARK.exec(raw);
  if (!match) return 'invalid';
  const maintenanceVersion = Number(match[1]);
  const mutationSeq = Number(match[2]);
  return isSafeCount(maintenanceVersion) && isSafeCount(mutationSeq) ? { maintenanceVersion, mutationSeq } : 'invalid';
}

function isWatermark(value: unknown): value is Watermark {
  return value !== null
    && typeof value === 'object'
    && isSafeCount((value as Watermark).maintenanceVersion)
    && isSafeCount((value as Watermark).mutationSeq);
}

function pageView(reply: OperatorReply, family: string): Record<string, unknown> | null {
  if (
    !isWatermark(reply.watermark)
    || reply.family !== family
    || !Array.isArray(reply.rows)
    || !(reply.nextCursor === null || typeof reply.nextCursor === 'string')
    || !Array.isArray(reply.families) || !reply.families.every((name) => typeof name === 'string')
    || !isSafeCount(reply.schemaVersion)
    || typeof reply.workspaceId !== 'string'
  ) {
    return null;
  }
  return {
    status: 'ok',
    watermark: { maintenanceVersion: reply.watermark.maintenanceVersion, mutationSeq: reply.watermark.mutationSeq },
    family,
    rows: reply.rows,
    nextCursor: reply.nextCursor,
    families: reply.families,
    schemaVersion: reply.schemaVersion,
    workspaceId: reply.workspaceId,
  };
}

export async function GET(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const params = new URL(request.url).searchParams;
    for (const name of params.keys()) {
      if (!ALLOWED_PARAMS.has(name)) return badRequest(LABEL, 'Unexpected query parameter.');
    }
    if (params.getAll('family').length !== 1 || params.getAll('cursor').length > 1 || params.getAll('watermark').length > 1) {
      return badRequest(LABEL, 'Each query parameter may appear once; family is required.');
    }
    const family = params.get('family') as string;
    if (!BACKUP_FAMILY_NAMES.includes(family)) return badRequest(LABEL, 'Unknown backup family.');
    const cursor = params.get('cursor');
    if (cursor !== null && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) {
      return badRequest(LABEL, 'Invalid cursor.');
    }
    const watermark = parseWatermark(params.get('watermark'));
    if (watermark === 'invalid') return badRequest(LABEL, 'watermark must be <maintenanceVersion>:<mutationSeq>.');
    if (cursor !== null && watermark === null) {
      return badRequest(LABEL, 'watermark is required for every page after the first.');
    }

    const result = await callOperatorRpc('exportBackupPage', {
      watermark,
      family,
      cursor,
      pageSize: BACKUP_MAX_CHUNK_ROWS,
    });
    if (result.kind !== 'reply') return rpcFailureResponse(LABEL, result, () => readUnavailableResponse(LABEL));
    const { reply } = result;
    if (reply.status === 'ok') {
      const view = pageView(reply, family);
      return view ? accepted(LABEL, view) : readUnavailableResponse(LABEL);
    }
    if (reply.status === 'not-frozen') {
      return conflict(LABEL, {
        error: 'Operational backups are taken only while the workspace is frozen or in recovery.',
        code: 'NOT_FROZEN',
      });
    }
    if (reply.status === 'watermark-changed') {
      return conflict(LABEL, {
        error: 'The workspace changed since the first page. This backup is incomplete; start a new one.',
        code: 'WATERMARK_CHANGED',
      });
    }
    if (reply.status === 'held') return heldResponse(LABEL, reply.reason);
    return readUnavailableResponse(LABEL);
  } catch (error) {
    return internalFailure(LABEL, error);
  }
}
