// Public deployment readiness. It exposes check booleans only and never
// configuration values, provider identifiers, URLs, prefixes, or secrets.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig } from '@/lib/hostedConfig';
import { getKVClient, getPlatformClient } from '@/lib/kvClient';
import { ensurePlatformSchemaLineage } from '@/lib/platformSchema';

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

export async function GET() {
  const config = getPublicConfig();
  const configurationReady = config.ready;
  const platformReady = config.mode && configurationReady
    ? await databaseReady(config.mode)
    : false;
  const schemaReady = config.mode === 'hosted' && configurationReady && platformReady
    ? await schemaLineageReady()
    : config.mode !== 'hosted';
  const ready = Boolean(configurationReady && platformReady && schemaReady);

  return NextResponse.json(
    {
      ready,
      mode: config.mode,
      checks: {
        configuration: configurationReady,
        platformDatabase: platformReady,
        ...(config.mode === 'hosted' ? { schemaLineage: schemaReady } : {}),
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
