// Public deployment readiness. It exposes check booleans only and never
// configuration values, provider identifiers, URLs, prefixes, or secrets.
// It never writes, dispatches work or calls a provider.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig, workerBindingPresence, workspaceReadinessError } from '@/lib/hostedConfig';
import { createFencedRedisPort, getKVClient, getPlatformClient } from '@/lib/kvClient';
import { ensurePlatformSchemaLineage } from '@/lib/platformSchema';
import { isCloudflareTarget } from '@/lib/runtime/capabilities';
import { resolveWorkspaceStore } from '@/lib/storage/resolve';

const READINESS_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('readiness timeout')), READINESS_TIMEOUT_MS);
    });
    return await Promise.race([work, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function databaseReady(mode: 'standalone' | 'hosted'): Promise<boolean> {
  try {
    const client = mode === 'hosted' ? getPlatformClient() : getKVClient();
    return await withTimeout(client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

async function schemaLineageReady(): Promise<boolean> {
  try {
    return await withTimeout(ensurePlatformSchemaLineage(getPlatformClient())) === 'ok';
  } catch {
    return false;
  }
}

async function workspaceStoreReady(): Promise<boolean> {
  try {
    const store = resolveWorkspaceStore({ redisClient: createFencedRedisPort, researcherId: null });
    return workspaceReadinessError(await withTimeout(store.readiness())) === null;
  } catch {
    return false;
  }
}

function respond(body: Record<string, unknown>, ready: boolean) {
  return NextResponse.json(body, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  const config = getPublicConfig();
  const configurationReady = config.ready;

  if (isCloudflareTarget()) {
    // Binding presence only: it does not prove the Queue is being consumed.
    const analysisQueue = workerBindingPresence().analysisQueue;
    const workspaceStore = configurationReady ? await workspaceStoreReady() : false;
    const ready = Boolean(configurationReady && workspaceStore && analysisQueue);
    return respond(
      {
        ready,
        mode: config.mode,
        target: 'cloudflare',
        checks: { configuration: configurationReady, workspaceStore, analysisQueue },
      },
      ready,
    );
  }

  const platformReady = config.mode && configurationReady
    ? await databaseReady(config.mode)
    : false;
  const schemaReady = config.mode === 'hosted' && configurationReady && platformReady
    ? await schemaLineageReady()
    : config.mode !== 'hosted';
  const ready = Boolean(configurationReady && platformReady && schemaReady);

  return respond(
    {
      ready,
      mode: config.mode,
      checks: {
        configuration: configurationReady,
        platformDatabase: platformReady,
        ...(config.mode === 'hosted' ? { schemaLineage: schemaReady } : {}),
      },
    },
    ready,
  );
}
