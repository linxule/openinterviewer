// POST /api/onboarding/validate-redis - Test Redis credentials with ping
// Only available in hosted mode

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getHostedResearcherIdentity } from '@/lib/researcherContext';
import { isHostedMode } from '@/lib/mode';
import { normalizeCredential, validateRedisCredentials } from '@/lib/credentialValidation';
import { consumePlatformRateLimit } from '@/lib/platformDb';
import { readBoundedJsonObject } from '@/lib/requestBody';

export async function POST(request: Request) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: 'Only available in hosted mode' }, { status: 404 });
  }

  const { authorized, researcherId, error } = await getHostedResearcherIdentity();
  if (!authorized || !researcherId) {
    return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  }
  const rateLimit = await consumePlatformRateLimit('redis-validation', researcherId, 30, 3_600);
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
    const parsedBody = await readBoundedJsonObject(request, 12_000);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.status === 413 ? 'Request body is too large' : 'Invalid request body' },
        { status: parsedBody.status }
      );
    }
    const redisUrl = normalizeCredential(parsedBody.value.redisUrl);
    const redisToken = normalizeCredential(parsedBody.value.redisToken);

    if (!redisUrl || !redisToken) {
      return NextResponse.json({ error: 'Missing redisUrl or redisToken' }, { status: 400 });
    }

    const result = await validateRedisCredentials(redisUrl, redisToken);
    if (result.valid) return NextResponse.json({ valid: true });
    return NextResponse.json(
      { valid: false, error: result.reason === 'invalid' ? 'Invalid Upstash Redis credentials.' : 'Could not reach Redis. Try again.' },
      { status: result.reason === 'invalid' ? 400 : 503 }
    );
  } catch (error) {
    console.error('Redis validation error:', error);
    return NextResponse.json({
      valid: false,
      error: 'Failed to connect. Check your URL and token.',
    });
  }
}
