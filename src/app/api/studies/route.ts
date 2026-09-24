// GET /api/studies - List all studies
// POST /api/studies - Create new study
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  createStudyAtomic,
  isKVAvailable,
  studyOperationMarkerId,
} from '@/lib/kv';
import {
  getHostedResearcherIdentity,
  getRequestContext,
  type ResearcherContext,
  type ResearcherSetupRequirement,
} from '@/lib/researcherContext';
import {
  inspectOwnedStudyGates,
  loadAllowedStudies,
  mapCollectionLoad,
  mapReadReadinessHold,
} from '@/lib/ownedStudies';
import { RESEARCHER_WORKSPACE_HELD_COPY, workspaceHeldResponse } from '@/lib/canonicalStudy';
import { configurationRequiredResponse, schemaHoldResponse } from '@/lib/researcherAccess';
import {
  beginCreateStudyOperationV2,
  consumePlatformRateLimit,
  getResearcherByIdChecked,
  loadResearcherStorageBinding,
  publishStudyOperationV2,
  resolveStudyOperationV2,
  type PendingStudyOperationV2,
} from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import {
  readStudyMutationBody,
  validateStudyConfigForCreate,
} from '@/lib/studyConfigValidation';
import { toStudyListItem, type StoredStudy, type StudyConfig } from '@/types';
import { missingProviderCredential } from '@/lib/providerAvailability';
import {
  attachCreateIdempotencyOperation,
  beginCreateIdempotency,
  casCreateIdempotencyState,
  createFingerprint,
  hashCreateIdempotencyKey,
  mintCreateStudy,
  parseIdempotencyKey,
  RETRY_AFTER_PENDING,
  STANDALONE_SCOPE,
  type CreateIdempotencyRecord,
} from '@/lib/createIdempotency';
import { getPlatformClient } from '@/lib/kvClient';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { isDurableWorkspaceStore, type StudyListView, type WorkspaceStorePort } from '@/lib/storage/types';

const COLLECTION_MESSAGES = {
  unavailable: 'Study storage is temporarily unavailable.',
  tooLarge: 'This study list is too large to load at once.',
};

/**
 * `?view=summary` lists study list items (ST-08); no `view` (or `view=full`)
 * keeps the legacy response of whole stored studies for older tabs and scripts.
 */
function studyListView(request: Request): StudyListView | null {
  const views = new URL(request.url).searchParams.getAll('view');
  if (views.length === 0) return 'full';
  return views.length === 1 && (views[0] === 'full' || views[0] === 'summary') ? views[0] : null;
}

// GET /api/studies - List all saved studies
export async function GET(request: Request) {
  try {
    const view = studyListView(request);
    if (!view) {
      return NextResponse.json({ error: 'view must be summary or full.' }, { status: 400 });
    }
    if (isHostedMode()) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
      }
      const inspection = await inspectOwnedStudyGates(identity.researcherId);
      const inspectionMapped = mapCollectionLoad(
        inspection.status === 'ok'
          ? { status: 'ok', items: inspection.pendingStudies, pendingStudies: inspection.pendingStudies }
          : inspection,
        {
          unavailable: 'Study storage is temporarily unavailable.',
          tooLarge: 'This study list is too large to load at once.',
        },
      );
      if (!inspectionMapped.ok) {
        return NextResponse.json(inspectionMapped.body, { status: inspectionMapped.status });
      }
      if (inspection.status !== 'ok' || inspection.allowedIds.length === 0) {
        return NextResponse.json({
          studies: inspectionMapped.items,
          pendingStudies: inspectionMapped.pendingStudies,
        });
      }

      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return setupResponse;
      if (!access.authorized || !access.context) {
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }

      const loaded = await loadAllowedStudies(inspection.allowedIds, access.context.kvClient);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Study storage is temporarily unavailable.',
        tooLarge: 'This study list is too large to load at once.',
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      return NextResponse.json({
        studies: [...inspection.pendingStudies, ...(view === 'summary' ? mapped.items.map(toStudyListItem) : mapped.items)],
        pendingStudies: inspection.pendingStudies,
      });
    }

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const store = context.store;
    const readiness = await store.readiness();
    if (readiness.status === 'unavailable') {
      // Only a Node deployment keeps the unconfigured-Redis empty list; a
      // durable workspace that cannot answer is never an empty success.
      if (isDurableWorkspaceStore(store)) {
        return NextResponse.json(
          { error: COLLECTION_MESSAGES.unavailable, retryable: true },
          { status: 503 },
        );
      }
      return NextResponse.json({
        studies: [],
        warning: 'Storage not configured. Connect Upstash Redis to enable persistence.'
      });
    }
    // Reads continue in every maintenance state and under a recovery-epoch
    // hold (an operator inspects a restored workspace before activation).
    const held = mapReadReadinessHold(readiness, '/api/studies');
    if (held) return held;

    const loaded = await store.listStudies(1_000, { view });
    const mapped = mapCollectionLoad(loaded, COLLECTION_MESSAGES);
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    return NextResponse.json({ studies: mapped.items });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies',
      method: 'GET',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to fetch studies' },
      { status: 500 }
    );
  }
}

// POST /api/studies - Create new study
export async function POST(request: Request) {
  try {
    const notReady = deploymentNotReadyResponse('/api/studies');
    if (notReady) return notReady;

    // Hosted: identity and account-record gates run before any BYOS cipher is
    // decrypted; the platform write path (rate limit, idempotency, begin) is
    // decided first, and only the create itself resolves BYOS credentials.
    const hosted = isHostedMode();
    let researcherId: string | null = null;
    let context: ResearcherContext | null = null;
    if (hosted) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
      }
      researcherId = identity.researcherId;
    } else {
      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return setupResponse;
      if (!access.authorized || !access.context) {
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }
      context = access.context;
    }

    const parsedBody = await readStudyMutationBody(request, 'create');
    if (!parsedBody.ok) {
      return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
    }

    const validatedConfig = validateStudyConfigForCreate(parsedBody.body.config, {
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: 1,
    });
    if (!validatedConfig.ok) {
      return NextResponse.json({ error: validatedConfig.error }, { status: 400 });
    }
    const serverConfig = validatedConfig.config;

    // Hosted setup/provider gates read the platform account record only, so
    // they fail closed without touching BYOS ciphers. Standalone keeps its
    // deployment context check.
    let missingProvider;
    try {
      if (hosted && researcherId) {
        const accountCheck = await getResearcherByIdChecked(researcherId);
        if (accountCheck.status === 'not-found') {
          return NextResponse.json({ error: 'Researcher account was not found' }, { status: 401 });
        }
        if (accountCheck.status === 'unavailable') {
          return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
        }
        const account = accountCheck.researcher;
        const setupMissing: ResearcherSetupRequirement[] = [];
        if (!account.onboardingComplete) setupMissing.push('onboarding');
        if (!account.encryptedRedisUrl) setupMissing.push('redis_url');
        if (!account.encryptedRedisToken) setupMissing.push('redis_token');
        if (setupMissing.length > 0) {
          const setupResponse = configurationRequiredResponse({
            authorized: true,
            context: null,
            researcherId,
            error: 'Researcher configuration is required',
            setupRequired: true,
            missing: setupMissing,
          });
          if (setupResponse) return setupResponse;
        }
        missingProvider = missingProviderCredential({
          geminiApiKey: account.encryptedGeminiApiKey,
          anthropicApiKey: account.encryptedAnthropicApiKey,
          openaiApiKey: account.encryptedOpenAiApiKey ?? null,
          openrouterApiKey: account.encryptedOpenRouterApiKey ?? null,
        }, serverConfig);
      } else {
        missingProvider = missingProviderCredential(context!, serverConfig);
      }
    } catch {
      return NextResponse.json({ error: 'The selected AI provider is invalid.' }, { status: 400 });
    }
    if (missingProvider) {
      return NextResponse.json({
        error: 'Connect a key for the selected AI provider before saving this study.',
        code: 'PROVIDER_NOT_CONFIGURED',
        provider: missingProvider,
      }, { status: 409 });
    }

    if (hosted && researcherId) {
      const rateLimit = await consumePlatformRateLimit(
        'study-create',
        researcherId,
        100,
        3_600
      );
      if (rateLimit.status === 'hold') return schemaHoldResponse();
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
    }

    const idempotencyKey = parseIdempotencyKey(request.headers.get('Idempotency-Key'));
    if (!idempotencyKey) {
      return NextResponse.json({ error: 'Idempotency-Key header must be a UUID.' }, { status: 400 });
    }

    if (!hosted) return await createStandaloneStudy(context!.store, serverConfig, idempotencyKey);

    // Hosted from here on: the cross-database create saga.
    const researcherScope = researcherId as string;
    const fingerprint = createFingerprint(serverConfig);
    const idempotencyHash = hashCreateIdempotencyKey(researcherScope, idempotencyKey);
    let idempClient;
    try {
      // Hosted idempotency lives on platform Redis; BYOS is not decrypted yet.
      idempClient = getPlatformClient();
    } catch {
      return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
    }

    const idemp = await beginCreateIdempotency({
      client: idempClient,
      mode: 'hosted',
      researcherId: researcherScope,
      idempotencyKey,
      fingerprint,
      mintStudy: () => mintCreateStudy(serverConfig),
    });
    const idempResponse = mapIdempotencyHttp(idemp);
    if (idempResponse) return idempResponse;

    const mapping = idemp.status === 'started' || idemp.status === 'replay'
      ? idemp.record
      : null;
    if (!mapping) {
      return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
    }

    const storedStudy: StoredStudy = mapping.study;

    // Hosted ownership and researcher storage are separate Redis databases.
    // Persist routing authority and a durable operation first; an ambiguous
    // BYOS response then remains repairable instead of triggering an unsafe
    // best-effort compensation. Minted study identity comes from the mapping.
    let operation: PendingStudyOperationV2 | null = null;
    let hostedStorageId: string | null = null;
    if (hosted) {
      const binding = await loadResearcherStorageBinding(researcherScope);
      if (binding.status !== 'ok') {
        return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
      }
      hostedStorageId = binding.binding.storageId;
      const begun = await beginCreateStudyOperationV2({
        researcherId: researcherScope,
        studyId: storedStudy.id,
        storageId: binding.binding.storageId,
        generation: 1,
        opNonce: randomBytes(16).toString('hex'),
        bindingEpoch: binding.binding.bindingEpoch,
        idempotencyHash,
        fingerprint,
        maxStudies: 1_000,
      });
      const beginResponse = mapBeginCreateHttp(begun);
      if (beginResponse) return beginResponse;
      if (begun.status !== 'started' && begun.status !== 'replay') {
        return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
      }
      if (begun.status === 'replay') {
        await attachCreateIdempotencyOperation({
          client: idempClient,
          mode: 'hosted',
          researcherId: researcherScope,
          idempotencyKey,
          fingerprint,
          operationId: begun.operation.id,
        });
        return pendingCreateResponse(mapping, begun.operation.id, begun.operation.phase);
      }
      operation = begun.operation;
      await attachCreateIdempotencyOperation({
        client: idempClient,
        mode: 'hosted',
        researcherId: researcherScope,
        idempotencyKey,
        fingerprint,
        operationId: operation.id,
      });
    }

    // BYOS credentials are decrypted only now, after lineage/idemp/begin have
    // decided. Contract 16.1: after begin-started, BYOS inability is 202.
    if (hosted) {
      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) {
        if (operation) return pendingCreateResponse(mapping, operation.id, operation.phase);
        return setupResponse;
      }
      if (!access.authorized || !access.context) {
        if (operation) return pendingCreateResponse(mapping, operation.id, operation.phase);
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }
      context = access.context;
    }

    const kvAvailable = await isKVAvailable(context!.kvClient);
    if (!kvAvailable) {
      if (operation) return pendingCreateResponse(mapping, operation.id, operation.phase);
      return NextResponse.json(
        { error: 'Storage not configured. Connect Upstash Redis to enable persistence.' },
        { status: 503 }
      );
    }

    const operationMarker = operation
      ? studyOperationMarkerId(`create:${operation.studyId}`, operation.createdAt)
      : studyOperationMarkerId(`create:${storedStudy.id}`, storedStudy.createdAt);
    if (!operationMarker) {
      return NextResponse.json({ error: 'Invalid study operation.' }, { status: 503 });
    }
    const creation = await createStudyAtomic(
      storedStudy,
      context!.kvClient,
      operationMarker,
      { idempotencyHash, researcherId: researcherScope },
    );
    if (creation === 'ambiguous') {
      return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
    }
    if (creation === 'unavailable') {
      // After begin-started, BYOS inability is durable-pending (202), not 503.
      if (operation) {
        return pendingCreateResponse(mapping, operation.id, operation.phase);
      }
      return NextResponse.json(
        { error: 'Failed to save study', retryable: true, reason: 'unavailable' },
        { status: 503 }
      );
    }
    if (creation === 'cancelled' || creation === 'conflict') {
      if (operation && hostedStorageId) {
        const rolledBack = await finalizeHostedCreate(operation, hostedStorageId, 'create-rollback');
        if (!rolledBack) {
          return pendingCreateResponse(mapping, operation.id, operation.phase);
        }
      }
      return NextResponse.json(
        {
          error: creation === 'cancelled'
            ? 'Study creation was cancelled during reconciliation.'
            : 'Study already exists',
        },
        { status: 409 }
      );
    }

    if (operation && hostedStorageId) {
      const finalized = await finalizeHostedCreate(operation, hostedStorageId, 'create-complete');
      if (!finalized) {
        return pendingCreateResponse(mapping, operation.id, operation.phase);
      }
    }

    await casCreateIdempotencyState({
      client: idempClient,
      mode: hosted ? 'hosted' : 'standalone',
      researcherId: researcherScope,
      idempotencyKey,
      fingerprint,
      nextState: 'created',
      operationId: operation?.id ?? mapping.operationId,
    });

    return NextResponse.json({
      study: storedStudy,
      message: 'Study saved successfully'
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/studies',
      method: 'POST',
      status: 500,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json(
      { error: 'Failed to create study' },
      { status: 500 }
    );
  }
}

function mapIdempotencyHttp(
  idemp: Awaited<ReturnType<typeof beginCreateIdempotency>>,
) {
  if (idemp.status === 'reuse') {
    return NextResponse.json({ code: 'IDEMPOTENCY_KEY_REUSE' }, { status: 409 });
  }
  if (idemp.status === 'quota') {
    return NextResponse.json({ retryable: true, reason: 'idempotency-quota' }, { status: 503 });
  }
  if (idemp.status === 'adel') {
    return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
  }
  if (idemp.status === 'hold') {
    return schemaHoldResponse();
  }
  if (idemp.status === 'noacct') {
    return NextResponse.json({ error: 'Researcher account is no longer available' }, { status: 401 });
  }
  if (idemp.status === 'ambiguous') {
    return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
  }
  if (idemp.status === 'unavailable') {
    return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
  }
  if (idemp.status === 'replay') {
    if (idemp.record.state === 'deleted') {
      return NextResponse.json({ code: 'IDEMPOTENCY_KEY_CONSUMED' }, { status: 409 });
    }
    if (idemp.record.state === 'created') {
      return NextResponse.json({
        study: idemp.record.study,
        message: 'Study saved successfully',
      });
    }
    // Hosted pending stays 202 (standalone pending replay re-enters the
    // atomic create inside the workspace store instead).
    return pendingCreateResponse(idemp.record, idemp.record.operationId);
  }
  return null;
}

/**
 * Standalone create (Node Redis and the Cloudflare workspace alike): the study
 * is minted here, outside any retried store transaction, and the store owns
 * the idempotency receipt, the atomic create and the created transition. On
 * Node the Redis store composes exactly the Redis calls this route used to
 * make; a replayed key returns the originally minted study.
 */
async function createStandaloneStudy(
  store: WorkspaceStorePort,
  config: StudyConfig,
  idempotencyKey: string,
) {
  const created = await store.createStudy({
    idempotencyKeyDigest: hashCreateIdempotencyKey(STANDALONE_SCOPE, idempotencyKey),
    fingerprint: createFingerprint(config),
    candidate: mintCreateStudy(config),
  });
  switch (created.status) {
    case 'created':
      return NextResponse.json({ study: created.study, message: 'Study saved successfully' });
    case 'key-reuse':
      return NextResponse.json({ code: 'IDEMPOTENCY_KEY_REUSE' }, { status: 409 });
    case 'key-consumed':
      return NextResponse.json({ code: 'IDEMPOTENCY_KEY_CONSUMED' }, { status: 409 });
    case 'conflict':
      return NextResponse.json({ error: 'Study already exists' }, { status: 409 });
    case 'quota':
      return NextResponse.json({ retryable: true, reason: 'idempotency-quota' }, { status: 503 });
    case 'ambiguous':
      return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
    case 'held':
      return workspaceHeldResponse({ route: '/api/studies', reason: created.reason, ...RESEARCHER_WORKSPACE_HELD_COPY });
    default:
      return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
  }
}

function mapBeginCreateHttp(
  begun: Awaited<ReturnType<typeof beginCreateStudyOperationV2>>,
) {
  if (begun.status === 'started' || begun.status === 'replay') return null;
  if (begun.status === 'studyquota') {
    return NextResponse.json(
      { error: 'Study quota reached. Delete an existing study before creating another.' },
      { status: 409 },
    );
  }
  if (begun.status === 'opquota') {
    return NextResponse.json(
      { error: 'Too many study changes are awaiting reconciliation.', retryable: true },
      { status: 503 },
    );
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
  if (begun.status === 'live' || begun.status === 'owner') {
    return NextResponse.json(
      {
        error: begun.status === 'owner'
          ? 'Study ownership conflicts with another account.'
          : 'Another study operation is still pending.',
      },
      { status: 409 },
    );
  }
  if (begun.status === 'ambiguous') {
    return NextResponse.json({ retryable: true, reason: 'ambiguous' }, { status: 503 });
  }
  return NextResponse.json({ retryable: true, reason: 'unavailable' }, { status: 503 });
}

async function finalizeHostedCreate(
  operation: PendingStudyOperationV2,
  storageId: string,
  resolution: 'create-complete' | 'create-rollback',
): Promise<boolean> {
  const resolved = await resolveStudyOperationV2({
    researcherId: operation.researcherId,
    studyId: operation.studyId,
    storageId,
    generation: operation.generation,
    kind: 'create',
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
    kind: 'create',
    opNonce: operation.opNonce,
    resolution: receipt?.resolution ?? resolution,
    createdAt: receipt?.createdAt ?? operation.createdAt,
  });
  return published.status === 'published' || published.status === 'pruned';
}

function pendingCreateResponse(
  record: CreateIdempotencyRecord,
  operationId?: string | null,
  phase = 'pending',
) {
  return NextResponse.json({
    message: 'Study creation is already awaiting reconciliation.',
    reconciliationPending: true,
    operationId: operationId ?? record.operationId,
    studyId: record.studyId,
    phase,
    retryAfterSeconds: RETRY_AFTER_PENDING,
    study: record.study,
  }, {
    status: 202,
    headers: { 'Retry-After': String(RETRY_AFTER_PENDING) },
  });
}
