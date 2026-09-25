// Researcher sign-in attempt budget on the Node standalone target's Redis
// (the Cloudflare counterpart is cloudflare/workspace/login.ts).
//
// Same policy: two fixed windows, each opened by its first counted attempt and
// never extended by later ones, one per client (loginClientKey, shared with
// Cloudflare, so no address reaches Redis) and one global. Windows are Redis
// key expiries, so they run on the Redis clock.
//
// Admission is one script, which Redis runs atomically: it refuses when either
// window is at its limit and otherwise counts the attempt in both, before the
// route compares the password. A refused attempt counts in neither window. A
// correct password refunds the attempt; a refund that never arrives leaves it
// counted (fail closed). The keys sit under the `rate-limit:` prefix of the
// participant limits, which the old-storage inventory already classifies.

import type { RedisPort } from '../redisPort';
import { loginClientKey } from './durableObject';
import {
  LOGIN_CLIENT_MAX_FAILURES,
  LOGIN_CLIENT_WINDOW_SECONDS,
  LOGIN_GLOBAL_MAX_FAILURES,
  LOGIN_GLOBAL_WINDOW_SECONDS,
  type LoginAttemptBudgetPort,
  type LoginBudgetAdmitOutcome,
  type LoginBudgetInput,
  type LoginBudgetRefundOutcome,
} from './types';

export const LOGIN_GLOBAL_KEY = `rate-limit:login:global:${LOGIN_GLOBAL_WINDOW_SECONDS}`;

export function loginClientRedisKey(clientKey: string): string {
  return `rate-limit:login:client:${LOGIN_CLIENT_WINDOW_SECONDS}:${clientKey}`;
}

// KEYS: global, client. ARGV: maximum and window (ms) per key, in KEYS order.
// Reply: {1, 0, 0} admitted, or {0, index of the limiting key, its remaining
// ms}; when both are full, the later end, since the earlier would only refuse
// again. A counter without an expiry (never written by this script) is given
// one, so it can never refuse forever. A non-numeric counter makes the script
// fail, and the route fails closed.
export const ADMIT_LOGIN_SCRIPT = `
local limited, retry = 0, 0
for i = 1, #KEYS do
  local maximum = tonumber(ARGV[(i - 1) * 2 + 1])
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= maximum then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then
      redis.call('PEXPIRE', KEYS[i], window)
      ttl = window
    end
    if ttl > retry then limited, retry = i, ttl end
  end
end
if limited > 0 then return {0, limited, retry} end

for i = 1, #KEYS do
  local window = tonumber(ARGV[(i - 1) * 2 + 2])
  redis.call('INCR', KEYS[i])
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], window) end
end
return {1, 0, 0}
`;

// Returns one admitted attempt to each window still open. A window left at
// zero is removed, so the next failure opens a fresh one.
export const REFUND_LOGIN_SCRIPT = `
for i = 1, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count <= 1 then redis.call('DEL', KEYS[i]) else redis.call('DECR', KEYS[i]) end
end
return 1
`;

const SCOPES = ['global', 'client'] as const;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The Node sign-in budget over the deployment's Redis. A thrown command or an
 * unexpected reply is `unavailable`: the route fails closed on admission.
 */
export function createRedisLoginBudget(client: RedisPort, rateLimitSalt: string): LoginAttemptBudgetPort {
  async function keys(input: LoginBudgetInput): Promise<string[]> {
    return [LOGIN_GLOBAL_KEY, loginClientRedisKey(await loginClientKey(rateLimitSalt, input.identity))];
  }

  return {
    async admitLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetAdmitOutcome> {
      try {
        const reply = await client.eval(ADMIT_LOGIN_SCRIPT, await keys(input), [
          String(LOGIN_GLOBAL_MAX_FAILURES),
          String(LOGIN_GLOBAL_WINDOW_SECONDS * 1000),
          String(LOGIN_CLIENT_MAX_FAILURES),
          String(LOGIN_CLIENT_WINDOW_SECONDS * 1000),
        ]);
        if (!Array.isArray(reply) || reply.length !== 3) return { status: 'unavailable' };
        const [admitted, index, retryMs] = reply as unknown[];
        if (admitted === 1 && index === 0 && retryMs === 0) return { status: 'admitted' };
        if (admitted === 0 && (index === 1 || index === 2) && isPositiveInteger(retryMs)) {
          return { status: 'limited', scope: SCOPES[index - 1], retryAfterSeconds: Math.ceil(retryMs / 1000) };
        }
        return { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },

    async refundLoginAttempt(input: LoginBudgetInput): Promise<LoginBudgetRefundOutcome> {
      try {
        const reply = await client.eval(REFUND_LOGIN_SCRIPT, await keys(input), []);
        return reply === 1 ? { status: 'refunded' } : { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
