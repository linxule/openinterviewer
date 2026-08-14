// GET /api/auth/me - Returns current researcher profile
// Used by client for displaying researcher info and onboarding status

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { getResearcherByIdChecked, toResearcherProfile } from '@/lib/platformDb';
import { isHostedMode } from '@/lib/mode';

export async function GET() {
  try {
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
    console.error('Auth me error:', error);
    return NextResponse.json(
      { error: 'Failed to get profile' },
      { status: 500 }
    );
  }
}
