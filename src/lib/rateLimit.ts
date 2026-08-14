import { createHmac } from 'crypto';
import { Redis } from '@upstash/redis';
import { NextResponse } from 'next/server';

type ParticipantOperation = 'greeting' | 'interview' | 'synthesis' | 'save';

type Limit = {
  scope: 'client' | 'session' | 'link' | 'study' | 'researcher';
  maximum: number;
  windowSeconds: number;
};

export type ParticipantRateLimitCounter = {
  key: string;
  maximum: number;
  windowSeconds: number;
};

const LIMITS: Record<ParticipantOperation, Limit[]> = {
  greeting: [
    { scope: 'session', maximum: 3, windowSeconds: 600 },
    { scope: 'client', maximum: 20, windowSeconds: 60 },
    { scope: 'study', maximum: 2_000, windowSeconds: 86_400 },
  ],
  interview: [
    { scope: 'session', maximum: 60, windowSeconds: 3_600 },
    { scope: 'client', maximum: 60, windowSeconds: 3_600 },
    { scope: 'link', maximum: 2_000, windowSeconds: 86_400 },
    { scope: 'study', maximum: 5_000, windowSeconds: 86_400 },
    { scope: 'researcher', maximum: 10_000, windowSeconds: 86_400 },
  ],
  synthesis: [
    { scope: 'session', maximum: 2, windowSeconds: 86_400 },
    { scope: 'client', maximum: 10, windowSeconds: 3_600 },
    { scope: 'link', maximum: 500, windowSeconds: 86_400 },
    { scope: 'study', maximum: 1_000, windowSeconds: 86_400 },
    { scope: 'researcher', maximum: 2_000, windowSeconds: 86_400 },
  ],
  save: [
    { scope: 'session', maximum: 2, windowSeconds: 86_400 },
    { scope: 'client', maximum: 20, windowSeconds: 3_600 },
    { scope: 'link', maximum: 1_000, windowSeconds: 86_400 },
    { scope: 'study', maximum: 2_000, windowSeconds: 86_400 },
  ],
};

// Check every scope before mutating any of them. Redis executes this script
// atomically, so a rejected request never burns a narrower budget first.
const CONSUME_LIMITS_SCRIPT = `
for i = 1, #KEYS do
  local maximum = tonumber(ARGV[(i - 1) * 2 + 1])
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= maximum then
    local ttl = redis.call('TTL', KEYS[i])
    return {0, i, ttl}
  end
end

for i = 1, #KEYS do
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('EXPIRE', KEYS[i], window) end
end

return {1, 0, 0}
`;

function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-vercel-forwarded-for')
    || request.headers.get('x-forwarded-for')
    || request.headers.get('x-real-ip')
    || 'unknown';
  const address = forwarded.split(',')[0]?.trim() || 'unknown';
  const salt = process.env.RATE_LIMIT_SALT
    || process.env.PARTICIPANT_TOKEN_SECRET
    || 'openinterviewer-rate-limit';
  return createHmac('sha256', salt).update(address).digest('hex').slice(0, 24);
}

export async function participantRateLimitResponse(
  request: Request,
  studyId: string,
  operation: ParticipantOperation,
  client: Redis,
  authority: { sessionId?: string; linkId?: string; researcherId?: string | null } = {}
): Promise<NextResponse | null> {
  try {
    const counters = getParticipantRateLimitCounters(request, studyId, operation, authority);
    if (!counters) {
      return NextResponse.json(
        { error: 'Participant request authority is incomplete.' },
        { status: 401 }
      );
    }
    const keys = counters.map(counter => counter.key);
    const args = counters.flatMap(counter => [String(counter.maximum), String(counter.windowSeconds)]);

    const [allowed, rejectedIndex, ttl] = await client.eval<string[], [number, number, number]>(
      CONSUME_LIMITS_SCRIPT,
      keys,
      args
    );
    if (allowed !== 1) {
      const rejectedLimit = LIMITS[operation][Math.max(0, rejectedIndex - 1)];
      const retryAfter = Math.max(1, ttl > 0 ? ttl : rejectedLimit.windowSeconds);
      return NextResponse.json(
        { error: 'Too many AI requests. Please wait before trying again.', retryable: true },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    return null;
  } catch (error) {
    console.error('Participant rate limiter unavailable', {
      operation,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      { error: 'Unable to verify request limits. Please try again later.', retryable: true },
      { status: 503 }
    );
  }
}

export function getParticipantRateLimitCounters(
  request: Request,
  studyId: string,
  operation: ParticipantOperation,
  authority: { sessionId?: string; linkId?: string; researcherId?: string | null } = {}
): ParticipantRateLimitCounter[] | null {
  const identity = clientIdentity(request);
  const counters: ParticipantRateLimitCounter[] = [];

  for (const limit of LIMITS[operation]) {
    const subject = limit.scope === 'client'
      ? `${studyId}:${identity}`
      : limit.scope === 'session'
        ? authority.sessionId
        : limit.scope === 'link'
          ? authority.linkId
          : limit.scope === 'researcher'
            ? authority.researcherId ?? studyId
            : studyId;
    if (!subject) return null;
    counters.push({
      key: `rate-limit:${operation}:${limit.scope}:${limit.windowSeconds}:${subject}`,
      maximum: limit.maximum,
      windowSeconds: limit.windowSeconds,
    });
  }

  return counters;
}
