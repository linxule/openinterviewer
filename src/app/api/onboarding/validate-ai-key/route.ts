// POST /api/onboarding/validate-ai-key - Test if an AI API key works
// Makes a small test call to verify the key is valid
// Only available in hosted mode

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity } from '@/lib/researcherContext';
import { isHostedMode } from '@/lib/mode';
import { normalizeCredential, validateAiCredential } from '@/lib/credentialValidation';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import { readBoundedJsonObject } from '@/lib/requestBody';
import { schemaHoldResponse } from '@/lib/researcherAccess';
import { createRequestId, logRequestFailure } from '@/lib/requestLog';

export async function POST(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const { authorized, researcherId, error } = await getHostedResearcherIdentity();
  if (!authorized || !researcherId) {
    return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  }
  const rateLimit = await consumePlatformRateLimit('ai-key-validation', researcherId, 30, 3_600);
  if (rateLimit.status === 'hold') return schemaHoldResponse();
  if (rateLimit.status === 'unavailable') {
    return NextResponse.json({ error: 'Validation is temporarily unavailable' }, { status: 503 });
  }
  if (rateLimit.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many validation attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  try {
    const parsedBody = await readBoundedJsonObject(request, 8_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
        { status: parsedBody.status }
      );
    }
    const provider = parsedBody.value.provider;
    const apiKey = normalizeCredential(parsedBody.value.apiKey);

    if (
      (
        provider !== 'gemini'
        && provider !== 'claude'
        && provider !== 'openai'
        && provider !== 'openrouter'
      )
      || !apiKey
    ) {
      return NextResponse.json({ error: 'Missing provider or apiKey' }, { status: 400 });
    }

    const result = await validateAiCredential(provider, apiKey);
    if (result.valid) return NextResponse.json({ valid: true });
    return NextResponse.json(
      { valid: false, error: result.reason === 'invalid' ? 'Invalid API key' : 'Provider validation is temporarily unavailable' },
      { status: result.reason === 'invalid' ? 400 : 503 }
    );
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/onboarding/validate-ai-key',
      method: 'POST',
      status: 200,
      requestId: createRequestId(request.headers.get('x-request-id')),
    }, error);
    return NextResponse.json({ valid: false, error: 'Validation request failed' });
  }
}
