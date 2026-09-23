// POST /api/operator/backup/import — send one operational backup chunk, or
// finalize (OPS-02, ST-10). Body: { manifest, chunk: {family, index, sha256,
// rows} | null, finalize? }. The object accepts chunks idempotently by
// (family, index) under one manifest digest, only in `recovery` and only into
// an empty workspace; finalize validates counts and references and keeps
// dispatch suspended. Cloudflare target only; operator authority required;
// exempt from the deployment-readiness gate (see ../../_lib/http.ts).
//
//   200 accepted { family, index, duplicate } | finalized { counts }
//   422 IMPORT_REJECTED { errorClass, counts? } (counts and a class, never content)
//   409 WORKSPACE_NOT_EMPTY | NOT_RECOVERY
//   503 WORKSPACE_HELD | OUTCOME_UNKNOWN (resending the same chunk is safe)

export const dynamic = 'force-dynamic';

import type { NextResponse } from 'next/server';
import { BACKUP_FAMILY_NAMES, BACKUP_MAX_CHUNK_ROWS } from '@/lib/backup/format';
import { operatorAuthorityRefusal, operatorRefusal, type OperatorRequestLabel } from '@/lib/operatorAuth';
import {
  accepted,
  badRequest,
  conflict,
  heldResponse,
  internalFailure,
  isCountRecord,
  isSafeCount,
  MAX_IMPORT_BODY_BYTES,
  outcomeUnknownResponse,
  readOperatorBody,
  rpcFailureResponse,
} from '../../_lib/http';
import { callOperatorRpc, type OperatorReply } from '../../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/backup/import', method: 'POST', operation: 'backup.import' };
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ERROR_CLASS = /^[a-z][a-z-]{0,63}$/;
const RESEND = 'Resend the same chunk (accepted chunks are acknowledged as duplicates), then finalize.';

type ChunkInput = { family: string; index: number; sha256: string; rows: unknown[] };

function chunkInput(value: unknown): ChunkInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const chunk = value as Record<string, unknown>;
  const keys = Object.keys(chunk);
  if (keys.length !== 4 || !['family', 'index', 'sha256', 'rows'].every((key) => keys.includes(key))) return null;
  if (typeof chunk.family !== 'string' || !BACKUP_FAMILY_NAMES.includes(chunk.family)) return null;
  if (!isSafeCount(chunk.index) || typeof chunk.sha256 !== 'string' || !SHA256_HEX.test(chunk.sha256)) return null;
  if (!Array.isArray(chunk.rows) || chunk.rows.length === 0 || chunk.rows.length > BACKUP_MAX_CHUNK_ROWS) return null;
  return { family: chunk.family, index: chunk.index, sha256: chunk.sha256, rows: chunk.rows };
}

function replyResponse(reply: OperatorReply): NextResponse {
  switch (reply.status) {
    case 'accepted':
      if (typeof reply.family !== 'string' || !isSafeCount(reply.index) || typeof reply.duplicate !== 'boolean') break;
      return accepted(LABEL, { status: 'accepted', family: reply.family, index: reply.index, duplicate: reply.duplicate });
    case 'finalized':
      if (!isCountRecord(reply.counts)) break;
      return accepted(LABEL, { status: 'finalized', counts: reply.counts });
    case 'rejected':
      return operatorRefusal(
        LABEL,
        422,
        {
          error: 'The workspace rejected this backup import.',
          code: 'IMPORT_REJECTED',
          errorClass: typeof reply.errorClass === 'string' && ERROR_CLASS.test(reply.errorClass) ? reply.errorClass : 'rejected',
          ...(isCountRecord(reply.counts) ? { counts: reply.counts } : {}),
        },
        'invalid',
      );
    case 'not-empty':
      return conflict(LABEL, { error: 'Import runs only into an empty workspace.', code: 'WORKSPACE_NOT_EMPTY' });
    case 'not-recovery':
      return conflict(LABEL, { error: 'Import runs only while the workspace is in recovery.', code: 'NOT_RECOVERY' });
    case 'held':
      return heldResponse(LABEL, reply.reason);
    default:
      break;
  }
  return outcomeUnknownResponse(LABEL, RESEND);
}

export async function POST(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const body = await readOperatorBody(request, LABEL, MAX_IMPORT_BODY_BYTES, ['manifest', 'chunk', 'finalize']);
    if (!body.ok) return body.response;
    const { manifest, finalize } = body.value;
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return badRequest(LABEL, 'manifest must be the backup manifest object.');
    }
    if (finalize !== undefined && typeof finalize !== 'boolean') return badRequest(LABEL, 'finalize must be a boolean.');
    const rawChunk = body.value.chunk ?? null;
    const chunk = rawChunk === null ? null : chunkInput(rawChunk);
    if (rawChunk !== null && !chunk) return badRequest(LABEL, 'chunk must be {family, index, sha256, rows} from the backup.');
    if ((chunk === null) === (finalize !== true)) return badRequest(LABEL, 'Send either one chunk or finalize: true.');

    const result = await callOperatorRpc('importBackupChunk', {
      manifest,
      chunk,
      finalize: finalize === true,
      now: Date.now(),
    });
    if (result.kind !== 'reply') return rpcFailureResponse(LABEL, result, () => outcomeUnknownResponse(LABEL, RESEND));
    return replyResponse(result.reply);
  } catch (error) {
    return internalFailure(LABEL, error);
  }
}
