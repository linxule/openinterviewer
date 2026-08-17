// GET /api/studies/[id] - Get study details
// PUT /api/studies/[id] - Update study config (soft lock: warns if has interviews)
// DELETE /api/studies/[id] - Delete study (fails if has interviews)
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  deleteStudy,
  getStudy,
  getStudyChecked,
  isKVAvailable,
  replaceStudyConfigAtomic,
  setStudyLinksEnabled,
  studyOperationMarkerId,
} from '@/lib/kv';
import {
  getAuthorizedResearcherStudyContext,
  getHostedResearcherIdentity,
  getRequestContext,
} from '@/lib/researcherContext';
import { mapStudyLoad } from '@/lib/ownedStudies';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  beginDeleteStudyOperationV2,
  loadResearcherStorageBinding,
  publishStudyOperationV2,
  resolveStudyOperationV2,
  type PendingStudyOperationV2,
} from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import {
  readStudyMutationBody,
  validateStudyConfigUpdate,
} from '@/lib/studyConfigValidation';
import { missingProviderCredential } from '@/lib/providerAvailability';
import { RETRY_AFTER_PENDING } from '@/lib/createIdempotency';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

// GET /api/studies/[id] - Get single study
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const gated = await getAuthorizedResearcherStudyContext(id, 'read');
    const denied = configurationRequiredResponse(gated);
    if (denied) return denied;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }

    const loaded = await getStudyChecked(id, gated.context.kvClient);
    const mapped = mapStudyLoad(loaded);
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    return NextResponse.json({ study: mapped.study });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]',
      method: 'GET',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to fetch study' },
      { status: 500 }
    );
  }
}

// PUT /api/studies/[id] - Update study config
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const parsedBody = await readStudyMutationBody(request, 'update');
    if (!parsedBody.ok) {
      return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    }
    const { config, confirmed, linksEnabled } = parsedBody.body;
    const isLinkOnlyUpdate = typeof linksEnabled === 'boolean' && config === undefined;

    const gated = await getAuthorizedResearcherStudyContext(
      id,
      isLinkOnlyUpdate ? 'link' : 'mutate-config',
    );
    const setupResponse = configurationRequiredResponse(gated);
    if (setupResponse) return setupResponse;
    if (!gated.authorized || !gated.context) {
      return NextResponse.json(
        {
          error: gated.error || 'Unauthorized',
          retryable: gated.retryable,
          ...(gated.code ? { code: gated.code } : {}),
          ...(gated.reason ? { reason: gated.reason } : {}),
        },
        { status: gated.statusCode ?? 401 },
      );
    }
    const context = gated.context;

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured' },
        { status: 503 }
      );
    }

    const study = await getStudy(id, context.kvClient);
    if (!study) {
      return NextResponse.json(
        { error: 'Study not found' },
        { status: 404 }
      );
    }

    // Revocation/restoration is deliberately independent from editable study
    // content and remains available after the first interview.
    if (isLinkOnlyUpdate) {
      const update = await setStudyLinksEnabled(id, linksEnabled, context.kvClient);
      if (update.status === 'not-found') {
        return NextResponse.json({ error: 'Study not found' }, { status: 404 });
      }
      if (update.status === 'persist-guard') {
        return liveStudyMutationResponse();
      }
      if (update.status !== 'updated') {
        return NextResponse.json({ error: 'Failed to update participant links' }, { status: 503 });
      }
      return NextResponse.json({ study: update.study, message: 'Participant link status updated' });
    }

    if (!config) {
      return NextResponse.json(
        { error: 'Missing required field: config' },
        { status: 400 }
      );
    }

    const validatedConfig = validateStudyConfigUpdate({
      ...study.config,
      id: study.id,
      createdAt: study.createdAt,
    }, config, linksEnabled);
    if (!validatedConfig.ok) {
      return NextResponse.json({ error: validatedConfig.error }, { status: 400 });
    }
    const updatedConfig = validatedConfig.config;
    let missingProvider;
    try {
      missingProvider = missingProviderCredential(context, updatedConfig);
    } catch {
      return NextResponse.json({ error: 'The selected AI provider is invalid.' }, { status: 400 });
    }
    if (missingProvider) {
      return NextResponse.json({
        error: 'Connect a key for the selected AI provider before updating this study.',
        code: 'PROVIDER_NOT_CONFIGURED',
        provider: missingProvider,
      }, { status: 409 });
    }

    // Soft lock: warn if study has interviews, allow if user confirms.
    if (study.interviewCount > 0 && !confirmed) {
      return NextResponse.json({
        warning: `This study has ${study.interviewCount} interview(s). Editing may affect data consistency.`,
        requiresConfirmation: true,
        interviewCount: study.interviewCount
      }, { status: 409 });
    }

    const update = await replaceStudyConfigAtomic(
      id,
      study.revision,
      updatedConfig,
      context.kvClient
    );
    if (update.status === 'conflict') {
      return NextResponse.json(
        { error: 'The study changed while you were editing it. Reload and try again.' },
        { status: 409 }
      );
    }
    if (update.status === 'not-found') {
      return NextResponse.json({ error: 'Study not found' }, { status: 404 });
    }
    if (update.status === 'persist-guard') {
      return liveStudyMutationResponse();
    }
    if (update.status !== 'updated') {
      return NextResponse.json({ error: 'Failed to update study' }, { status: 503 });
    }

    return NextResponse.json({
      study: update.study,
      message: 'Study updated successfully'
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]',
      method: 'PUT',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to update study' },
      { status: 500 }
    );
  }
}

// DELETE /api/studies/[id] - Delete study
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // No preliminary GET. Hosted begin owns owner/journal/bind before BYOS
    // decrypt. The atomic wrapper owns missing-state, persist-guard, and
    // terminal receipt replay.
    let operation: PendingStudyOperationV2 | null = null;
    let hostedStorageId: string | null = null;
    let kvClient;
    if (isHostedMode()) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
      }
      const binding = await loadResearcherStorageBinding(identity.researcherId);
      if (binding.status !== 'ok') {
        return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
      }
      hostedStorageId = binding.binding.storageId;
      const begun = await beginDeleteStudyOperationV2({
        researcherId: identity.researcherId,
        studyId: id,
        storageId: binding.binding.storageId,
        generation: 1,
        opNonce: randomBytes(16).toString('hex'),
        bindingEpoch: binding.binding.bindingEpoch,
        idempotencyHash: null,
        fingerprint: null,
      });
      const beginResponse = mapBeginDeleteHttp(begun);
      if (beginResponse) return beginResponse;
      if (begun.status !== 'started' && begun.status !== 'replay') {
        return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
      }
      if (begun.status === 'replay') {
        return pendingDeleteResponse(begun.operation);
      }
      operation = begun.operation;

      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return pendingDeleteResponse(operation);
      if (!access.authorized || !access.context) {
        return pendingDeleteResponse(operation);
      }
      kvClient = access.context.kvClient;
    } else {
      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return setupResponse;
      if (!access.authorized || !access.context) {
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }
      kvClient = access.context.kvClient;
    }

    const kvAvailable = await isKVAvailable(kvClient);
    if (!kvAvailable) {
      if (operation) return pendingDeleteResponse(operation);
      return NextResponse.json(
        { error: 'Storage not configured' },
        { status: 503 }
      );
    }

    const operationMarker = operation
      ? studyOperationMarkerId(`delete:${operation.studyId}`, operation.createdAt)
      : studyOperationMarkerId(`delete:${id}`, 0);
    if (!operationMarker) {
      return NextResponse.json({ error: 'Invalid study operation.' }, { status: 503 });
    }
    const result = await deleteStudy(
      id,
      kvClient,
      operationMarker
    );
    if (result.status === 'ambiguous') {
      return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
    }
    if (result.status === 'still-pending') {
      if (operation) {
        return pendingDeleteResponse(operation);
      }
      return NextResponse.json({ code: 'STUDY_PERSIST_PENDING' }, { status: 409 });
    }
    if (!result.success) {
      if (!operation) {
        if (result.status === 'not-found') {
          return NextResponse.json({ error: result.error || 'Study not found' }, { status: 404 });
        }
        if (result.status === 'conflict' || result.status === 'cancelled') {
          return NextResponse.json(
            { error: result.error || 'Failed to delete study' },
            { status: 409 }
          );
        }
        return NextResponse.json(
          { error: result.error || 'Failed to delete study', retryable: true, reason: 'unavailable' },
          { status: 503 }
        );
      }

      if (result.status === 'cancelled' || result.error === 'Study operation cancelled') {
        const rolledBack = hostedStorageId
          ? await finalizeHostedDelete(operation, hostedStorageId, 'delete-rollback')
          : false;
        if (!rolledBack) {
          return pendingDeleteResponse(operation);
        }
        return NextResponse.json(
          { error: 'Study deletion was cancelled during reconciliation.' },
          { status: 409 }
        );
      }

      if (result.status === 'conflict' || result.error === 'Cannot delete study with existing interviews') {
        const rolledBack = hostedStorageId
          ? await finalizeHostedDelete(operation, hostedStorageId, 'delete-rollback')
          : false;
        if (!rolledBack) {
          return pendingDeleteResponse(operation);
        }
        return NextResponse.json(
          { error: result.error || 'Failed to delete study' },
          { status: 409 }
        );
      }

      if (result.status !== 'not-found' && result.error !== 'Study not found') {
        return pendingDeleteResponse(operation);
      }
    }

    if (operation && hostedStorageId) {
      const finalized = await finalizeHostedDelete(operation, hostedStorageId, 'delete-complete');
      if (!finalized) {
        return pendingDeleteResponse(operation);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Study deleted successfully'
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies/[id]',
      method: 'DELETE',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to delete study' },
      { status: 500 }
    );
  }
}

function mapBeginDeleteHttp(
  begun: Awaited<ReturnType<typeof beginDeleteStudyOperationV2>>,
) {
  if (begun.status === 'started' || begun.status === 'replay') return null;
  if (begun.status === 'notfound') {
    return NextResponse.json({ error: 'Study ownership record is missing' }, { status: 404 });
  }
  if (begun.status === 'owner') {
    return NextResponse.json({ error: 'Study ownership does not match this account' }, { status: 403 });
  }
  if (begun.status === 'noacct') {
    return NextResponse.json(
      { error: 'Researcher account is no longer available' },
      { status: 401 },
    );
  }
  if (begun.status === 'hold') {
    return NextResponse.json({ retryable: false, reason: 'schema-hold' }, { status: 503 });
  }
  if (begun.status === 'opquota') {
    return NextResponse.json(
      { error: 'Too many study changes are awaiting reconciliation.', retryable: true },
      { status: 503 },
    );
  }
  if (begun.status === 'live') {
    return NextResponse.json(
      { error: 'Another study operation is still pending.' },
      { status: 409 },
    );
  }
  if (begun.status === 'ambiguous') {
    return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
  }
  return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
}

async function finalizeHostedDelete(
  operation: PendingStudyOperationV2,
  storageId: string,
  resolution: 'delete-complete' | 'delete-rollback',
): Promise<boolean> {
  const resolved = await resolveStudyOperationV2({
    researcherId: operation.researcherId,
    studyId: operation.studyId,
    storageId,
    generation: operation.generation,
    kind: 'delete',
    opNonce: operation.opNonce,
    resolution,
    createdAt: operation.createdAt,
  });
  if (resolved.status === 'terminal') return true;
  if (resolved.status !== 'publishing') return false;
  const receipt = resolved.operation.frozenReceipt;
  const published = await publishStudyOperationV2({
    researcherId: operation.researcherId,
    studyId: operation.studyId,
    generation: operation.generation,
    kind: 'delete',
    opNonce: operation.opNonce,
    resolution: receipt?.resolution ?? resolution,
    createdAt: receipt?.createdAt ?? operation.createdAt,
  });
  return published.status === 'published' || published.status === 'pruned';
}

function liveStudyMutationResponse() {
  return NextResponse.json(
    { code: 'STUDY_OPERATION_PENDING', retryable: true },
    { status: 409 },
  );
}

function pendingDeleteResponse(operation: PendingStudyOperationV2) {
  return NextResponse.json({
    message: 'Study deletion is already awaiting reconciliation.',
    reconciliationPending: true,
    operationId: operation.id,
    studyId: operation.studyId,
    phase: operation.phase,
    retryAfterSeconds: RETRY_AFTER_PENDING,
  }, {
    status: 202,
    headers: { 'Retry-After': String(RETRY_AFTER_PENDING) },
  });
}
