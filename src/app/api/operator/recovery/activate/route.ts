// POST /api/operator/recovery/activate — controlled recovery-epoch activation
// after a restore or import (JOB-10, OPS-03). Body: { expectedActivatedEpoch }
// (the activated epoch `status` reported). Compare-and-set inside the object,
// only in `recovery`: every restored unfinished generation becomes
// recovery-required, then the deployment's configured epoch is activated.
// The epoch value itself always comes from the Worker's secret binding, never
// from this request. Cloudflare target only; operator authority required;
// exempt from the deployment-readiness gate (see ../../_lib/http.ts).
//
//   200 activated { reconciledJobs } | already-active
//   409 EPOCH_CONFLICT | NOT_RECOVERY
//   503 WORKSPACE_HELD | OUTCOME_UNKNOWN (read status before retrying)

export const dynamic = 'force-dynamic';

import { operatorAuthorityRefusal, type OperatorRequestLabel } from '@/lib/operatorAuth';
import { isValidRecoveryEpoch } from '@/lib/storage/analysisProtocol';
import {
  accepted,
  badRequest,
  conflict,
  heldResponse,
  internalFailure,
  isSafeCount,
  outcomeUnknownResponse,
  readOperatorBody,
  rpcFailureResponse,
} from '../../_lib/http';
import { callOperatorRpc } from '../../_lib/workspaceRpc';

const LABEL: OperatorRequestLabel = { route: '/api/operator/recovery/activate', method: 'POST', operation: 'recovery.activate' };
const MAX_BODY_BYTES = 1024;
const READ_STATUS_FIRST = 'Read status: it reports the activated epoch and whether it matches the deployment.';

export async function POST(request: Request) {
  try {
    const refused = await operatorAuthorityRefusal(request, LABEL);
    if (refused) return refused;

    const body = await readOperatorBody(request, LABEL, MAX_BODY_BYTES, ['expectedActivatedEpoch']);
    if (!body.ok) return body.response;
    const { expectedActivatedEpoch } = body.value;
    if (!isValidRecoveryEpoch(expectedActivatedEpoch)) {
      return badRequest(LABEL, 'expectedActivatedEpoch must be the activated epoch status reports (ep_ followed by 32 hex digits).');
    }

    const result = await callOperatorRpc('activateRecoveryEpoch', { expectedActivatedEpoch, now: Date.now() });
    if (result.kind !== 'reply') {
      return rpcFailureResponse(LABEL, result, () => outcomeUnknownResponse(LABEL, READ_STATUS_FIRST));
    }
    const { reply } = result;
    switch (reply.status) {
      case 'activated':
        if (!isSafeCount(reply.reconciledJobs)) break;
        return accepted(LABEL, { status: 'activated', reconciledJobs: reply.reconciledJobs });
      case 'already-active':
        return accepted(LABEL, { status: 'already-active' });
      case 'conflict':
        return conflict(LABEL, {
          error: 'The activated epoch is not the one expected, an import is unfinished, or the configured epoch was already replaced.',
          code: 'EPOCH_CONFLICT',
        });
      case 'not-recovery':
        return conflict(LABEL, { error: 'Activation runs only while the workspace is in recovery.', code: 'NOT_RECOVERY' });
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
