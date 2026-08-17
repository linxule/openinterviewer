// GET /api/config/readiness — public hosted/standalone readiness.
// Booleans and safe error identifiers only. Never secret or URL values.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig } from '@/lib/hostedConfig';
import { getPlatformClient } from '@/lib/kvClient';
import { ensurePlatformSchemaLineage } from '@/lib/platformSchema';

export async function GET() {
  const config = getPublicConfig();
  if (config.mode !== 'hosted' || !config.ready) {
    return NextResponse.json(config);
  }

  try {
    const lineage = await ensurePlatformSchemaLineage(getPlatformClient());
    if (lineage === 'hold') {
      return NextResponse.json({
        ...config,
        ready: false,
        errors: [...config.errors, 'schema_hold'],
      });
    }
  } catch {
    return NextResponse.json({
      ...config,
      ready: false,
      errors: [...config.errors, 'schema_hold'],
    });
  }

  return NextResponse.json(config);
}
