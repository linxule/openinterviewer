import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from './auth';
import { isHostedMode } from './mode';
import {
  consumePlatformRateLimits,
  type PlatformRateLimitCounter,
} from './platformDb';

export type HostedAiOperation =
  | 'greeting'
  | 'interview'
  | 'synthesis'
  | 'aggregate'
  | 'followup'
  | 'analysis';

type ScopePolicy = {
  session: { maximum: number; windowSeconds: number };
  network: { maximum: number; windowSeconds: number };
  researcher: { maximum: number; windowSeconds: number };
};

// Platform-compute budgets. Researcher API/provider spend remains governed by
// their provider account; these limits protect the hosted application itself.
export const HOSTED_AI_RATE_LIMIT_POLICY: Record<HostedAiOperation, ScopePolicy> = {
  greeting: {
    session: { maximum: 3, windowSeconds: 600 },
    network: { maximum: 200, windowSeconds: 3_600 },
    researcher: { maximum: 5_000, windowSeconds: 86_400 },
  },
  interview: {
    session: { maximum: 60, windowSeconds: 3_600 },
    network: { maximum: 500, windowSeconds: 3_600 },
    researcher: { maximum: 10_000, windowSeconds: 86_400 },
  },
  synthesis: {
    session: { maximum: 2, windowSeconds: 86_400 },
    network: { maximum: 100, windowSeconds: 3_600 },
    researcher: { maximum: 2_000, windowSeconds: 86_400 },
  },
  aggregate: {
    session: { maximum: 20, windowSeconds: 3_600 },
    network: { maximum: 100, windowSeconds: 3_600 },
    researcher: { maximum: 100, windowSeconds: 86_400 },
  },
  followup: {
    session: { maximum: 20, windowSeconds: 3_600 },
    network: { maximum: 100, windowSeconds: 3_600 },
    researcher: { maximum: 100, windowSeconds: 86_400 },
  },
  // Researcher-triggered interview analysis (slice P). `session` at 100/hour
  // admits a 25-interview batch four times an hour; `researcher` at 500/day
  // bounds platform exposure. The deferred (`after()`) path keeps consuming
  // `synthesis` with the participant session — one save, one analysis,
  // inside the existing budget.
  analysis: {
    session: { maximum: 100, windowSeconds: 3_600 },
    network: { maximum: 200, windowSeconds: 3_600 },
    researcher: { maximum: 500, windowSeconds: 86_400 },
  },
};

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [key, ...parts] = pair.trim().split('=');
    if (key === name) return parts.join('=') || null;
  }
  return null;
}

function networkAddress(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for')
    || request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || 'unknown';
  return forwarded.split(',')[0]?.trim() || 'unknown';
}

function subjectDigest(salt: string, scope: string, subject: string): string {
  return createHmac('sha256', salt)
    .update(`${scope}:${subject}`)
    .digest('hex');
}

export async function hostedAiRateLimitResponse(
  request: Request,
  operation: HostedAiOperation,
  authority: { researcherId?: string | null; participantSessionId?: string }
): Promise<NextResponse | null> {
  if (!isHostedMode()) return null;

  const researcherId = authority.researcherId;
  const sessionIdentity = authority.participantSessionId
    || cookieValue(request, SESSION_COOKIE_NAME);
  const salt = process.env.RATE_LIMIT_SALT;
  if (
    !researcherId
    || researcherId.length > 256
    || !sessionIdentity
    || sessionIdentity.length > 8_192
    || !salt
    || salt.length < 32
  ) {
    return NextResponse.json(
      { error: 'Unable to verify hosted AI request limits. Please try again later.', retryable: true },
      { status: 503 }
    );
  }

  const policy = HOSTED_AI_RATE_LIMIT_POLICY[operation];
  const subjects = {
    session: subjectDigest(salt, 'session', sessionIdentity),
    network: subjectDigest(salt, 'network', networkAddress(request)),
    researcher: subjectDigest(salt, 'researcher', researcherId),
  };
  const counters: PlatformRateLimitCounter[] = (
    ['session', 'network', 'researcher'] as const
  ).map(scope => ({
    operation: `ai-${operation}-${scope}`,
    subject: subjects[scope],
    maximum: policy[scope].maximum,
    windowSeconds: policy[scope].windowSeconds,
  }));

  const result = await consumePlatformRateLimits(counters);
  if (result.status === 'allowed') return null;
  if (result.status === 'limited') {
    return NextResponse.json(
      { error: 'Too many hosted AI requests. Please wait before trying again.', retryable: true },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
    );
  }
  return NextResponse.json(
    { error: 'Unable to verify hosted AI request limits. Please try again later.', retryable: true },
    { status: 503 }
  );
}
