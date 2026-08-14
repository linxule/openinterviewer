// GET /api/studies/[id] - Get study details
// PUT /api/studies/[id] - Update study config (soft lock: warns if has interviews)
// DELETE /api/studies/[id] - Delete study (fails if has interviews)
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  deleteStudy,
  getStudy,
  isKVAvailable,
  replaceStudyConfigAtomic,
  setStudyLinksEnabled,
  studyOperationMarkerId,
} from '@/lib/kv';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  beginDeleteStudyOperation,
  PendingStudyOperation,
  resolveStudyOperation,
} from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import {
  readStudyMutationBody,
  validateStudyConfigUpdate,
} from '@/lib/studyConfigValidation';

// GET /api/studies/[id] - Get single study
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

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

    return NextResponse.json({ study });
  } catch (error) {
    console.error('Get study API error:', error);
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
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const parsedBody = await readStudyMutationBody(request, 'update');
    if (!parsedBody.ok) {
      return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    }
    const { config, confirmed, linksEnabled } = parsedBody.body;

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

    const isLinkOnlyUpdate = typeof linksEnabled === 'boolean' && config === undefined;

    // Revocation/restoration is deliberately independent from editable study
    // content and remains available after the first interview.
    if (isLinkOnlyUpdate) {
      const update = await setStudyLinksEnabled(id, linksEnabled, context.kvClient);
      if (update.status === 'not-found') {
        return NextResponse.json({ error: 'Study not found' }, { status: 404 });
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
    if (update.status !== 'updated') {
      return NextResponse.json({ error: 'Failed to update study' }, { status: 503 });
    }

    return NextResponse.json({
      study: update.study,
      message: 'Study updated successfully'
    });
  } catch (error) {
    console.error('Update study API error:', error);
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
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, researcherId, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

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

    // Record hosted delete intent before touching BYOS, but preserve routing
    // authority until BYOS absence is known. Ambiguous storage results leave the
    // durable operation pending for reconciliation.
    let operation: PendingStudyOperation | null = null;
    if (isHostedMode()) {
      if (!researcherId) {
        return NextResponse.json({ error: 'Researcher identity is required' }, { status: 401 });
      }
      const begun = await beginDeleteStudyOperation(id, researcherId);
      if (begun.status === 'owner-conflict') {
        return NextResponse.json({ error: 'Study ownership does not match this account' }, { status: 403 });
      }
      if (begun.status === 'not-found') {
        return NextResponse.json({ error: 'Study ownership record is missing' }, { status: 409 });
      }
      if (begun.status === 'pending-quota-exceeded') {
        return NextResponse.json(
          { error: 'Too many study changes are awaiting reconciliation.', retryable: true },
          { status: 503 }
        );
      }
      if (begun.status === 'account-not-found') {
        return NextResponse.json(
          { error: 'Researcher account is no longer available' },
          { status: 401 }
        );
      }
      if (begun.status !== 'started' && begun.status !== 'already-pending') {
        return NextResponse.json(
          {
            error: begun.status === 'operation-conflict'
              ? 'Another study operation is still pending.'
              : begun.status === 'invalid'
                ? 'Invalid study operation.'
                : 'Unable to begin study deletion.',
            retryable: begun.status === 'unavailable',
          },
          { status: begun.status === 'operation-conflict' ? 409 : 503 }
        );
      }
      if (begun.status === 'already-pending') {
        return NextResponse.json({
          message: 'Study deletion is already awaiting reconciliation.',
          reconciliationPending: true,
          operationId: begun.operation.id,
        }, { status: 202 });
      }
      operation = begun.operation;
    }

    const operationMarker = operation
      ? studyOperationMarkerId(operation.id, operation.createdAt)
      : undefined;
    if (operation && !operationMarker) {
      return NextResponse.json({ error: 'Invalid study operation.' }, { status: 503 });
    }
    const result = await deleteStudy(
      id,
      context.kvClient,
      operationMarker || undefined
    );
    if (!result.success) {
      if (!operation) {
        return NextResponse.json(
          { error: result.error || 'Failed to delete study' },
          { status: 400 }
        );
      }

      if (result.error === 'Study operation cancelled') {
        await resolveStudyOperation(operation, 'delete-rollback');
        return NextResponse.json(
          { error: 'Study deletion was cancelled during reconciliation.' },
          { status: 409 }
        );
      }

      // The two business outcomes are definitive Redis script results. Any
      // generic failure is ambiguous and must remain pending: a command whose
      // response was lost may still land after an immediate verification read.
      if (result.error !== 'Cannot delete study with existing interviews'
        && result.error !== 'Study not found') {
        return NextResponse.json({
          error: 'Study deletion is awaiting reconciliation.',
          retryable: true,
          operationId: operation.id,
        }, { status: 503 });
      }

      if (result.error === 'Cannot delete study with existing interviews') {
        const rolledBack = await resolveStudyOperation(operation, 'delete-rollback');
        if (rolledBack !== 'resolved' && rolledBack !== 'already-resolved') {
          return NextResponse.json({
            error: 'Study deletion could not be finalized and is awaiting reconciliation.',
            retryable: true,
            operationId: operation.id,
          }, { status: 503 });
        }
        return NextResponse.json(
          { error: result.error || 'Failed to delete study' },
          { status: 400 }
        );
      }
    }

    if (operation) {
      const finalized = await resolveStudyOperation(operation, 'delete-complete');
      if (finalized !== 'resolved' && finalized !== 'already-resolved') {
        return NextResponse.json({
          message: 'Study deleted; platform reconciliation is pending.',
          reconciliationPending: true,
          operationId: operation.id,
        }, { status: 202 });
      }
    }

    return NextResponse.json({
      message: 'Study deleted successfully'
    });
  } catch (error) {
    console.error('Delete study API error:', error);
    return NextResponse.json(
      { error: 'Failed to delete study' },
      { status: 500 }
    );
  }
}
