// Public deployment readiness. It exposes check booleans only and never
// configuration values, provider identifiers, URLs, prefixes, or secrets.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig } from '@/lib/hostedConfig';
import { getKVClient, getPlatformClient } from '@/lib/kvClient';

const READINESS_TIMEOUT_MS = 2_000;

async function databaseReady(mode: 'standalone' | 'hosted'): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('readiness timeout')), READINESS_TIMEOUT_MS);
    });
    const client = mode === 'hosted' ? getPlatformClient() : getKVClient();
    const pong = await Promise.race([client.ping(), deadline]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const config = getPublicConfig();
  const configurationReady = config.ready;
  const platformReady = config.mode && configurationReady
    ? await databaseReady(config.mode)
    : false;
  const ready = configurationReady && platformReady;

  return NextResponse.json(
    {
      ready,
      mode: config.mode,
      checks: {
        configuration: configurationReady,
        platformDatabase: platformReady,
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
