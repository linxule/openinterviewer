import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { consumePlatformRateLimit } from './platformDb';

type OAuthRateLimitOperation =
  | 'oauth-google-start'
  | 'oauth-google-callback'
  | 'oauth-github-start'
  | 'oauth-github-callback';

function networkSubject(request: Request): string | null {
  const salt = process.env.RATE_LIMIT_SALT;
  if (!salt || salt.length < 32) return null;
  const forwarded = request.headers.get('x-vercel-forwarded-for')
    || request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || 'unknown';
  const address = forwarded.split(',')[0]?.trim() || 'unknown';
  return createHmac('sha256', salt).update(address).digest('hex').slice(0, 32);
}

export async function oauthRateLimitResponse(
  request: Request,
  operation: OAuthRateLimitOperation,
  maximum: number
): Promise<NextResponse | null> {
  const subject = networkSubject(request);
  if (!subject) {
    return NextResponse.json({ error: 'Sign-in is temporarily unavailable' }, { status: 503 });
  }

  const result = await consumePlatformRateLimit(operation, subject, maximum, 3_600);
  if (result.status === 'allowed') return null;
  if (result.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
    );
  }
  return NextResponse.json({ error: 'Sign-in is temporarily unavailable' }, { status: 503 });
}
