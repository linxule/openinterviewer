// GET /api/config/readiness — public hosted/standalone readiness.
// Booleans and safe error identifiers only. Never secret or URL values.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPublicConfig } from '@/lib/hostedConfig';

export async function GET() {
  return NextResponse.json(getPublicConfig());
}
