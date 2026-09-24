// Authenticated sample-workspace fixture. This is separate from the public,
// in-memory /demo and writes synthetic records to the deployment's workspace
// store (Redis on Node, the WorkspaceStore Durable Object on Cloudflare).
// Protected: requires an authenticated researcher session.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getRequestContext, type ResearcherContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { DEMO_STUDIES, DEMO_INTERVIEWS } from '@/lib/demoData';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import {
  isGatewayAuthConfigured,
  isGatewayProvider,
} from '@/lib/aiTransport';
import { logRequestFailure } from '@/lib/requestLog';
import { RESEARCHER_WORKSPACE_HELD_COPY, workspaceHeldResponse } from '@/lib/canonicalStudy';
import { mapReadinessHold, RESEARCHER_MUTATION_STATES } from '@/lib/ownedStudies';
import { deploymentNotReadyResponse } from '@/lib/runtime/readinessGate';
import { activeAITransport, isCloudflareTarget } from '@/lib/runtime/capabilities';
import { currentWorkerInvocation } from '@/lib/runtime/workerInvocation';
import { isDurableWorkspaceStore, type WorkspaceHoldReason, type WorkspaceStorePort } from '@/lib/storage/types';
import type { AIProviderType } from '@/types';

const ROUTE = '/api/demo/seed';

function heldResponse(reason: WorkspaceHoldReason) {
  return workspaceHeldResponse({ route: ROUTE, reason, ...RESEARCHER_WORKSPACE_HELD_COPY });
}

function seedStorageUnavailable(store: WorkspaceStorePort) {
  return NextResponse.json(
    isDurableWorkspaceStore(store)
      ? {
          error: 'Workspace storage is temporarily unavailable. Try again before loading sample workspace data.',
          retryable: true,
        }
      : { error: 'Storage not configured. Connect Upstash Redis before loading sample workspace data.' },
    { status: 503 }
  );
}

function sampleAlreadyLoadedResponse() {
  return NextResponse.json(
    { error: 'Sample workspace data is already loaded. Clear it before reloading.' },
    { status: 409 }
  );
}

/**
 * Whether a fixture study is already present. Used only on the
 * missing-provider path, so an already-loaded sample keeps its 409 ahead of
 * provider configuration (the former route checked collisions first) without
 * adding a read to the seeding path. A read that cannot answer is not
 * evidence of presence.
 */
async function sampleStudyPresent(store: WorkspaceStorePort): Promise<boolean> {
  for (const study of DEMO_STUDIES) {
    if ((await store.getStudy(study.id)).status === 'found') return true;
  }
  return false;
}

type ProviderKeys = Pick<ResearcherContext, 'geminiApiKey' | 'anthropicApiKey' | 'openaiApiKey' | 'openrouterApiKey'>;

function hasKey(context: ProviderKeys, provider: AIProviderType): boolean {
  const key = provider === 'gemini'
    ? context.geminiApiKey
    : provider === 'claude'
      ? context.anthropicApiKey
      : provider === 'openai'
        ? context.openaiApiKey
        : context.openrouterApiKey;
  return Boolean(key?.trim());
}

function isProvider(value: string): value is AIProviderType {
  return Object.prototype.hasOwnProperty.call(DEFAULT_MODEL_BY_PROVIDER, value);
}

/**
 * The sample studies' provider. On Cloudflare it is the installation's
 * AI_PROVIDER from the current Worker invocation (default gemini, as the
 * readiness validator treats it) and only when that provider's key is present;
 * the Cloudflare context's keys come from the same invocation env. Direct and
 * Cloudflare AI Gateway both send the provider's own key, so there is no
 * substitution of another provider.
 */
function sampleProvider(context: ProviderKeys): AIProviderType | null {
  if (isCloudflareTarget()) {
    const configured = currentWorkerInvocation()?.env.AI_PROVIDER;
    const provider = typeof configured === 'string' && configured.trim() ? configured.trim() : 'gemini';
    return isProvider(provider) && hasKey(context, provider) ? provider : null;
  }
  const configuredGatewayProvider = process.env.AI_PROVIDER?.trim() || 'gemini';
  if (
    activeAITransport() === 'gateway'
    && isGatewayAuthConfigured()
    && isGatewayProvider(configuredGatewayProvider)
  ) {
    return configuredGatewayProvider;
  }
  const order: AIProviderType[] = ['gemini', 'claude', 'openai', 'openrouter'];
  return order.find(provider => hasKey(context, provider)) ?? null;
}

export async function POST() {
  try {
    const notReady = deploymentNotReadyResponse(ROUTE);
    if (notReady) return notReady;

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }
    const store = context.store;

    // Storage is reported before provider configuration, as it always was.
    const readiness = await store.readiness();
    if (readiness.status === 'unavailable') return seedStorageUnavailable(store);
    const held = mapReadinessHold(readiness, RESEARCHER_MUTATION_STATES, ROUTE);
    if (held) return held;

    const aiProvider = sampleProvider(context);
    if (!aiProvider) {
      if (await sampleStudyPresent(store)) return sampleAlreadyLoadedResponse();
      return NextResponse.json(
        { error: 'AI provider not configured. Configure the active AI transport before loading sample workspace data.' },
        { status: 503 }
      );
    }

    // Never mutate the process-wide fixtures. A warm function may serve
    // researchers with different provider configurations in sequence.
    const studiesToSeed = structuredClone(DEMO_STUDIES);
    const interviewsToSeed = structuredClone(DEMO_INTERVIEWS);
    for (const study of studiesToSeed) {
      study.config.aiProvider = aiProvider;
      study.config.aiModel = DEFAULT_MODEL_BY_PROVIDER[aiProvider];
      if (aiProvider !== 'gemini') {
        // The legacy reasoning toggle is a Gemini-only study option.
        delete study.config.enableReasoning;
      }
    }

    // One domain operation: the store refuses a collision with an already
    // loaded fixture and never overwrites a present record.
    const seeded = await store.seedSampleWorkspace({
      studies: studiesToSeed,
      interviews: interviewsToSeed,
      now: Date.now(),
    });
    if (seeded.status === 'already-seeded') return sampleAlreadyLoadedResponse();
    if (seeded.status === 'held') return heldResponse(seeded.reason);
    if (seeded.status !== 'seeded') return seedStorageUnavailable(store);

    return NextResponse.json({
      success: true,
      message: 'Sample workspace data loaded successfully',
      data: {
        studiesSeeded: seeded.studiesSeeded,
        interviewsSeeded: seeded.interviewsSeeded,
        aggregateSynthesisAvailable:
          seeded.studiesSeeded === studiesToSeed.length && seeded.interviewsSeeded >= 2
      }
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'POST',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to seed sample workspace data' },
      { status: 500 }
    );
  }
}

// Clear the authenticated sample-workspace fixture: only the known fixture
// ids, through the store's scoped clear (never caller-selected records).
export async function DELETE() {
  try {
    const notReady = deploymentNotReadyResponse(ROUTE);
    if (notReady) return notReady;

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const store = context.store;
    const cleared = await store.clearSampleWorkspace({
      studyIds: DEMO_STUDIES.map(study => study.id),
      interviewIds: DEMO_INTERVIEWS.map(interview => interview.id),
    });
    if (cleared.status === 'has-participant-data') {
      return NextResponse.json(
        {
          error: 'The sample study now holds participant interviews, so the sample workspace was not cleared.',
          code: 'SAMPLE_HAS_PARTICIPANT_DATA',
        },
        { status: 409 }
      );
    }
    if (cleared.status === 'held') return heldResponse(cleared.reason);
    if (cleared.status === 'ambiguous') {
      return NextResponse.json(
        {
          error: 'Clearing the sample workspace may not have finished. Try again.',
          retryable: true,
          reason: 'ambiguous',
        },
        { status: 503 }
      );
    }
    if (cleared.status !== 'cleared') {
      return NextResponse.json(
        isDurableWorkspaceStore(store)
          ? { error: 'Workspace storage is temporarily unavailable. Try again before clearing sample workspace data.', retryable: true }
          : { error: 'Storage not configured.' },
        { status: 503 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Sample workspace data cleared',
      data: {
        studiesDeleted: cleared.studiesDeleted,
        interviewsDeleted: cleared.interviewsDeleted
      }
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: ROUTE,
      method: 'DELETE',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to clear sample workspace data' },
      { status: 500 }
    );
  }
}
