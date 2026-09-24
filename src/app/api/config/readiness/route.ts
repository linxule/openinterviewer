// GET /api/config/readiness — public deployment readiness (always 200).
// Booleans and safe error identifiers only. Never secret or URL values.
// It never writes, dispatches work or calls a provider; on Cloudflare it
// never constructs Redis.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig, workspaceReadinessError, type PublicConfigView } from '@/lib/hostedConfig';
import { createFencedRedisPort, getPlatformClient } from '@/lib/kvClient';
import { ensurePlatformSchemaLineage } from '@/lib/platformSchema';
import { isCloudflareTarget } from '@/lib/runtime/capabilities';
import { resolveWorkspaceStore } from '@/lib/storage/resolve';

const WORKSPACE_READINESS_TIMEOUT_MS = 2_000;

function respond(body: PublicConfigView) {
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

async function workspaceError(): Promise<ReturnType<typeof workspaceReadinessError>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = resolveWorkspaceStore({ redisClient: createFencedRedisPort, researcherId: null });
    const deadline = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), WORKSPACE_READINESS_TIMEOUT_MS);
    });
    return workspaceReadinessError(await Promise.race([store.readiness(), deadline]));
  } catch {
    return 'workspace_unavailable';
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const config = getPublicConfig();

  if (isCloudflareTarget()) {
    if (!config.ready) return respond(config);
    const error = await workspaceError();
    return respond(error ? { ...config, ready: false, errors: [...config.errors, error] } : config);
  }

  if (config.mode !== 'hosted' || !config.ready) {
    return respond(config);
  }

  try {
    const lineage = await ensurePlatformSchemaLineage(getPlatformClient());
    if (lineage === 'hold') {
      return respond({
        ...config,
        ready: false,
        errors: [...config.errors, 'schema_hold'],
      });
    }
  } catch {
    return respond({
      ...config,
      ready: false,
      errors: [...config.errors, 'schema_hold'],
    });
  }

  return respond(config);
}
