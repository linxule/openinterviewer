// GET /api/config/mode - Returns deployment mode and configured OAuth providers.
// Used by client to decide whether to show OAuth or password login.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig } from '@/lib/hostedConfig';

export async function GET() {
  const config = getPublicConfig();
  return NextResponse.json({
    mode: config.mode,
    oauth: config.oauth,
    ready: config.ready,
    errors: config.errors,
  });
}
