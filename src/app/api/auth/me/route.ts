// GET /api/auth/me - Returns current researcher profile
// Used by client for displaying researcher info and onboarding status
//
// Cloudflare target: standalone only. The request context comes from the
// target-aware getRequestContext (Worker invocation env and the workspace
// Durable Object); no Redis client or hosted platform lookup is ever built.
// An unsupported target configuration or missing workspace binding is a
// 503, never a signed-out 401.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { getResearcherByIdChecked, toResearcherProfile } from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';
import { logRequestFailure } from '@/lib/requestLog';
import { isCloudflareTarget, resolveCapabilities } from '@/lib/runtime/capabilities';

function notConfigured(error?: string) {
  return NextResponse.json(
    { error: error || 'This deployment is not configured.', retryable: false },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function cloudflareProfile() {
  if (!resolveCapabilities().ok) return notConfigured();
  const { authorized, context, error, statusCode } = await getRequestContext();
  if (!authorized) {
    return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  }
  if (!context) {
    return statusCode && statusCode !== 401
      ? NextResponse.json({ error: error || 'Service unavailable' }, { status: statusCode, headers: { 'Cache-Control': 'no-store' } })
      : notConfigured(error);
  }
  return NextResponse.json({
    mode: 'standalone',
    authenticated: true,
  });
}

export async function GET() {
  try {
    if (isCloudflareTarget()) return await cloudflareProfile();

    // In standalone mode, return basic info
    if (!isHostedMode()) {
      const { authorized, context, error } = await getRequestContext();
      if (!authorized || !context) {
        return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
      }
      return NextResponse.json({
        mode: 'standalone',
        authenticated: true,
      });
    }

    // Hosted onboarding and account repair need identity without configured BYOS.
    const identity = await getHostedResearcherIdentity();
    if (!identity.authorized || !identity.researcherId) {
      return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
    }

    const loaded = await getResearcherByIdChecked(identity.researcherId);
    if (loaded.status === 'unavailable') {
      return NextResponse.json({ error: 'Account storage is temporarily unavailable' }, { status: 503 });
    }
    if (loaded.status === 'not-found') {
      return NextResponse.json({ error: 'Researcher not found' }, { status: 404 });
    }

    return NextResponse.json({
      mode: 'hosted',
      authenticated: true,
      profile: toResearcherProfile(loaded.researcher),
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/auth/me',
      method: 'GET',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to get profile' },
      { status: 500 }
    );
  }
}
