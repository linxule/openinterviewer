// GET /api/config/status - Returns provider availability for the active transport.
// Only returns non-secret booleans and transport identity, never key values.
//
// Cloudflare target: the context comes from the target-aware
// getRequestContext (provider keys from the Worker invocation env, the
// workspace Durable Object as storage); no Redis client or hosted platform
// lookup is ever built. The response adds the resolved storage capability
// (`storage: 'workspace-do'`); key availability stays booleans only.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { isHostedMode } from '@/lib/mode';
import { getResearcherByIdChecked, toResearcherProfile } from '@/lib/platformDb';
import { isGatewayAuthConfigured, resolveAITransport } from '@/lib/aiTransport';
import { logRequestFailure } from '@/lib/requestLog';
import { isCloudflareTarget, resolveCapabilities } from '@/lib/runtime/capabilities';

function notConfigured(error?: string) {
  return NextResponse.json(
    { error: error || 'This deployment is not configured.', retryable: false },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function cloudflareStatus() {
  const resolved = resolveCapabilities();
  if (!resolved.ok) return notConfigured();
  const { authorized, context, error, statusCode } = await getRequestContext();
  if (!authorized) {
    return NextResponse.json({ error: error || 'Authentication required' }, { status: 401 });
  }
  if (!context) {
    return statusCode && statusCode !== 401
      ? NextResponse.json({ error: error || 'Service unavailable' }, { status: statusCode, headers: { 'Cache-Control': 'no-store' } })
      : notConfigured(error);
  }
  return NextResponse.json({
    mode: 'standalone',
    aiTransport: resolved.capabilities.transport,
    storage: resolved.capabilities.storage,
    hasAnthropicKey: !!context.anthropicApiKey,
    hasGeminiKey: !!context.geminiApiKey,
    hasOpenAiKey: !!context.openaiApiKey,
    hasOpenRouterKey: !!context.openrouterApiKey,
  });
}

export async function GET() {
  try {
    if (isCloudflareTarget()) return await cloudflareStatus();

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
        aiTransport: 'direct',
        hasAnthropicKey: profile.hasAnthropicKey,
        hasGeminiKey: profile.hasGeminiKey,
        hasOpenAiKey: profile.hasOpenAiKey,
        hasOpenRouterKey: profile.hasOpenRouterKey,
      });
    }

    const { authorized, context, error } = await getRequestContext();
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Authentication required' }, { status: 401 });
    }

    // Return researcher-specific key status from context
    // In standalone mode, these come from env vars
    // In hosted mode, these come from the researcher's decrypted credentials
    const aiTransport = resolveAITransport();
    const gatewayReady = aiTransport === 'gateway' && isGatewayAuthConfigured();
    const status = {
      mode: 'standalone',
      aiTransport,
      hasAnthropicKey: gatewayReady || !!context.anthropicApiKey,
      hasGeminiKey: gatewayReady || !!context.geminiApiKey,
      hasOpenAiKey: gatewayReady || !!context.openaiApiKey,
      hasOpenRouterKey: aiTransport === 'direct' && !!context.openrouterApiKey,
    };

    return NextResponse.json(status);
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/config/status',
      method: 'GET',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to check configuration status' },
      { status: 500 }
    );
  }
}
