// GET /api/studies - List all studies
// POST /api/studies - Create new study
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  createStudyAtomic,
  getAllStudies,
  isKVAvailable,
  studyOperationMarkerId,
} from '@/lib/kv';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import {
  beginCreateStudyOperation,
  consumePlatformRateLimit,
  PendingStudyOperation,
  resolveStudyOperation,
} from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import {
  readStudyMutationBody,
  validateStudyConfigForCreate,
} from '@/lib/studyConfigValidation';
import { StoredStudy } from '@/types';
import { randomUUID } from 'crypto';

// GET /api/studies - List all saved studies
export async function GET() {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json({
        studies: [],
        warning: 'Storage not configured. Connect Vercel KV to enable persistence.'
      });
    }

    const studies = await getAllStudies(context.kvClient);
    return NextResponse.json({ studies });
  } catch (error) {
    console.error('Studies API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch studies' },
      { status: 500 }
    );
  }
}

// POST /api/studies - Create new study
export async function POST(request: Request) {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, researcherId, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const parsedBody = await readStudyMutationBody(request, 'create');
    if (!parsedBody.ok) {
      return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    }

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured. Connect Vercel KV to enable persistence.' },
        { status: 503 }
      );
    }

    // Create server-assigned ID
    const now = Date.now();
    const studyId = randomUUID();
    const validatedConfig = validateStudyConfigForCreate(parsedBody.body.config, {
      id: studyId,
      createdAt: now,
    });
    if (!validatedConfig.ok) {
      return NextResponse.json({ error: validatedConfig.error }, { status: 400 });
    }
    const serverConfig = validatedConfig.config;

    const storedStudy: StoredStudy = {
      id: studyId,
      config: serverConfig,
      createdAt: now,
      updatedAt: now,
      interviewCount: 0,
      isLocked: false,
      revision: 1
    };

    // Hosted ownership and researcher storage are separate Redis databases.
    // Persist routing authority and a durable operation first; an ambiguous
    // BYOS response then remains repairable instead of triggering an unsafe
    // best-effort compensation.
    let operation: PendingStudyOperation | null = null;
    if (isHostedMode()) {
      if (!researcherId) {
        return NextResponse.json({ error: 'Researcher identity is required' }, { status: 401 });
      }
      const rateLimit = await consumePlatformRateLimit(
        'study-create',
        researcherId,
        100,
        3_600
      );
      if (rateLimit.status === 'unavailable') {
        return NextResponse.json(
          { error: 'Unable to verify study creation limits. Try again later.', retryable: true },
          { status: 503 }
        );
      }
      if (rateLimit.status === 'limited') {
        return NextResponse.json(
          { error: 'Too many studies created. Try again later.' },
          { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
        );
      }
      const begun = await beginCreateStudyOperation(studyId, researcherId);
      if (begun.status === 'study-quota-exceeded') {
        return NextResponse.json(
          { error: 'Study quota reached. Delete an existing study before creating another.' },
          { status: 409 }
        );
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
            error: begun.status === 'owner-conflict'
              ? 'Study ownership conflicts with another account.'
              : begun.status === 'operation-conflict'
                ? 'Another study operation is still pending.'
                : begun.status === 'invalid'
                  ? 'Invalid study operation.'
                  : 'Unable to begin study creation. Study was not created.',
            retryable: begun.status === 'unavailable',
          },
          { status: begun.status === 'owner-conflict' || begun.status === 'operation-conflict' ? 409 : 503 }
        );
      }
      if (begun.status === 'already-pending') {
        return NextResponse.json({
          message: 'Study creation is already awaiting reconciliation.',
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
    const creation = await createStudyAtomic(
      storedStudy,
      context.kvClient,
      operationMarker || undefined
    );
    if (creation === 'unavailable') {
      return NextResponse.json(
        {
          error: operation
            ? 'Study creation is awaiting reconciliation.'
            : 'Failed to save study',
          retryable: true,
          operationId: operation?.id,
        },
        { status: 503 }
      );
    }
    if (creation === 'cancelled' && operation) {
      await resolveStudyOperation(operation, 'create-rollback');
      return NextResponse.json(
        { error: 'Study creation was cancelled during reconciliation.' },
        { status: 409 }
      );
    }

    if (operation) {
      const finalized = await resolveStudyOperation(operation, 'create-complete');
      if (finalized !== 'resolved' && finalized !== 'already-resolved') {
        // BYOS existence is known and authority remains registered. Leave the
        // durable operation for the reconciler instead of detaching authority.
        return NextResponse.json({
          study: storedStudy,
          message: 'Study saved; platform reconciliation is pending.',
          reconciliationPending: true,
          operationId: operation.id,
        }, { status: 202 });
      }
    }

    if (creation === 'conflict') {
      return NextResponse.json({ error: 'Study already exists' }, { status: 409 });
    }

    return NextResponse.json({
      study: storedStudy,
      message: 'Study saved successfully'
    });
  } catch (error) {
    console.error('Create study API error:', error);
    return NextResponse.json(
      { error: 'Failed to create study' },
      { status: 500 }
    );
  }
}
