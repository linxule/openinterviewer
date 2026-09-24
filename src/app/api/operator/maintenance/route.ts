// POST /api/operator/maintenance — compare-and-set maintenance transition
// (OPS-01). Body: { expectedState, expectedVersion, nextState,
// classifyInFlight? }. Cloudflare target only; operator authority required.
//
//   200 transitioned | already (a replay of the recorded transition)
//   409 MAINTENANCE_CONFLICT with the current { state, version }
//   409 ANALYSIS_IN_FLIGHT with { claimed, started } (pass classifyInFlight)
//   409 INVALID_TRANSITION
//   503 WORKSPACE_HELD | OUTCOME_UNKNOWN (read status before retrying)
//
// A transition that enables more work passes the deployment-readiness gate
// first; one that tightens the hold is exempt (see ../_lib/http.ts).

export const dynamic = 'force-dynamic';

import { operatorAuthorityRefusal, logOperatorAction, type OperatorRequestLabel } from '@/lib/operatorAuth';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
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
  transitionResumesWork,
} from '../_lib/http';
import { callOperatorRpc } from '../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/maintenance', method: 'POST', operation: 'maintenance' };
const MAX_BODY_BYTES = 1024;
const READ_STATUS_FIRST = 'Read status, then decide on the next transition from the state it reports.';

export async function POST(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const body = await readOperatorBody(request, LABEL, MAX_BODY_BYTES, [
      'expectedState',
      'expectedVersion',
      'nextState',
      'classifyInFlight',
    ]);
    if (!body.ok) return body.response;
    const { expectedState, expectedVersion, nextState, classifyInFlight } = body.value;
    if (!isMaintenanceState(expectedState) || !isMaintenanceState(nextState)) {
      return badRequest(LABEL, 'expectedState and nextState must be open, draining, frozen or recovery.');
    }
    if (!isSafeCount(expectedVersion)) return badRequest(LABEL, 'expectedVersion must be a non-negative integer.');
    if (classifyInFlight !== undefined && typeof classifyInFlight !== 'boolean') {
      return badRequest(LABEL, 'classifyInFlight must be a boolean.');
    }

    if (transitionResumesWork(expectedState, nextState)) {
      const notReady = deploymentNotReadyResponse(LABEL.route);
      if (notReady) {
        logOperatorAction(LABEL, 503, 'not-configured');
        return notReady;
      }
    }

    const result = await callOperatorRpc('transitionMaintenance', {
      expectedState,
      expectedVersion,
      nextState,
      classifyInFlight: classifyInFlight === true,
      now: Date.now(),
    });
    if (result.kind !== 'reply') {
      return rpcFailureResponse(LABEL, result, () => outcomeUnknownResponse(LABEL, READ_STATUS_FIRST));
    }
    const { reply } = result;
    switch (reply.status) {
      case 'transitioned':
      case 'already':
        if (!isMaintenanceState(reply.state) || !isSafeCount(reply.version)) break;
        return accepted(LABEL, { status: reply.status, state: reply.state, version: reply.version });
      case 'conflict':
        if (!isMaintenanceState(reply.state) || !isSafeCount(reply.version)) break;
        return conflict(LABEL, {
          error: 'The workspace is not in the expected state and version.',
          code: 'MAINTENANCE_CONFLICT',
          state: reply.state,
          version: reply.version,
        });
      case 'in-flight':
        if (!isSafeCount(reply.claimed) || !isSafeCount(reply.started)) break;
        return conflict(LABEL, {
          error: 'Analysis attempts are in flight. Wait for them to settle, or classify them explicitly.',
          code: 'ANALYSIS_IN_FLIGHT',
          claimed: reply.claimed,
          started: reply.started,
        });
      case 'invalid-transition':
        return conflict(LABEL, {
          error: 'This transition is not allowed from the current state.',
          code: 'INVALID_TRANSITION',
        });
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
