// GET /api/operator/status — workspace maintenance state/version, activated
// recovery epoch, record counts, analysis job counts and the scheduled alarm
// (OPS-01, OPS-03). Cloudflare target only; operator authority required.
// Counts and identifiers only, never research content. Exempt from the
// deployment-readiness gate (see ../_lib/http.ts).

export const dynamic = 'force-dynamic';

import { operatorAuthorityRefusal, type OperatorRequestLabel } from '@/lib/operatorAuth';
import {
  accepted,
  heldResponse,
  internalFailure,
  isCountRecord,
  isMaintenanceState,
  isSafeCount,
  readUnavailableResponse,
  rpcFailureResponse,
} from '../_lib/http';
import { callOperatorRpc, type OperatorReply } from '../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/status', method: 'GET', operation: 'status' };

type StatusView = {
  workspaceId: string;
  schemaVersion: number;
  maintenance: { state: string; version: number };
  epoch: { activated: string; configuredMatches: boolean };
  counts: Record<string, number>;
  jobs: { pending: number; claimed: number; started: number; recoveryRequired: number; oldestActiveAgeMs: number | null };
  alarm: { scheduledAt: number | null };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A closed projection of the object's status reply, or null when it is malformed. */
function statusView(reply: OperatorReply): StatusView | null {
  const maintenance = record(reply.maintenance);
  const epoch = record(reply.epoch);
  const jobs = record(reply.jobs);
  const alarm = record(reply.alarm);
  if (
    typeof reply.workspaceId !== 'string'
    || !isSafeCount(reply.schemaVersion)
    || !maintenance || !isMaintenanceState(maintenance.state) || !isSafeCount(maintenance.version)
    || !epoch || typeof epoch.activated !== 'string' || typeof epoch.configuredMatches !== 'boolean'
    || !isCountRecord(reply.counts)
    || !jobs
    || !isSafeCount(jobs.pending) || !isSafeCount(jobs.claimed) || !isSafeCount(jobs.started)
    || !isSafeCount(jobs.recoveryRequired)
    || !(jobs.oldestActiveAgeMs === null || isSafeCount(jobs.oldestActiveAgeMs))
    || !alarm || !(alarm.scheduledAt === null || isSafeCount(alarm.scheduledAt))
  ) {
    return null;
  }
  return {
    workspaceId: reply.workspaceId,
    schemaVersion: reply.schemaVersion,
    maintenance: { state: maintenance.state, version: maintenance.version },
    epoch: { activated: epoch.activated, configuredMatches: epoch.configuredMatches },
    counts: { ...reply.counts },
    jobs: {
      pending: jobs.pending,
      claimed: jobs.claimed,
      started: jobs.started,
      recoveryRequired: jobs.recoveryRequired,
      oldestActiveAgeMs: jobs.oldestActiveAgeMs as number | null,
    },
    alarm: { scheduledAt: alarm.scheduledAt as number | null },
  };
}

export async function GET(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const result = await callOperatorRpc('operatorStatus');
    if (result.kind !== 'reply') return rpcFailureResponse(LABEL, result, () => readUnavailableResponse(LABEL));
    const { reply } = result;
    if (reply.status === 'held') return heldResponse(LABEL, reply.reason);
    const view = reply.status === 'ok' ? statusView(reply) : null;
    if (!view) return readUnavailableResponse(LABEL);
    return accepted(LABEL, { status: 'ok', ...view });
  } catch (error) {
    return internalFailure(LABEL, error);
  }
}
