// GET /api/config/status - Returns which optional API keys are configured
// Only returns boolean status, never actual key values

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { isHostedMode } from '@/lib/mode';
import { getResearcherByIdChecked, toResearcherProfile } from '@/lib/platformDb';

export async function GET() {
  try {
    // Configuration remains inspectable while hosted BYOS setup is incomplete.
    // Return booleans from the encrypted account record without decrypting secrets.
    if (isHostedMode()) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json(
          { error: identity.error || 'Authentication required' },
          { status: 401 }
        );
      }

      const loaded = await getResearcherByIdChecked(identity.researcherId);
      if (loaded.status === 'unavailable') {
        return NextResponse.json(
          { error: 'Account storage is temporarily unavailable' },
          { status: 503 }
        );
      }
      if (loaded.status === 'not-found') {
        return NextResponse.json({ error: 'Researcher not found' }, { status: 404 });
      }

      const profile = toResearcherProfile(loaded.researcher);
      return NextResponse.json({
        mode: 'hosted',
        hasAnthropicKey: profile.hasAnthropicKey,
        hasGeminiKey: profile.hasGeminiKey,
      });
    }

    const { authorized, context, error } = await getRequestContext();
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Authentication required' }, { status: 401 });
    }

    // Return researcher-specific key status from context
    // In standalone mode, these come from env vars
    // In hosted mode, these come from the researcher's decrypted credentials
    const status = {
      mode: 'standalone',
      hasAnthropicKey: !!context.anthropicApiKey,
      hasGeminiKey: !!context.geminiApiKey,
    };

    return NextResponse.json(status);
  } catch (error) {
    console.error('Config status API error:', error);
    return NextResponse.json(
      { error: 'Failed to check configuration status' },
      { status: 500 }
    );
  }
}
