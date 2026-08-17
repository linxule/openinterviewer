// Public Redis port (Revision 12 §2).
// Every injectable parameter, wrapper, lazy BYOS acquire, Upstash adapter, and
// node-redis adapter is typed as RedisPort. Never type injectables as `Redis`
// from @upstash/redis (protected members). Values passed to SET/HSET are
// prefixed strings; never pass JS objects to the SDK.

export type RedisEvalArg = string;

export interface RedisPort {
  // The defaulted type parameter is additive: `get(key)` resolves to
  // Promise<unknown> exactly as the closed interface declares, while legacy
  // call sites that spell `get<T>` keep compiling until later phases convert
  // (Revision 12 §2). Post-conversion, `Redis` from @upstash/redis is never
  // used as an injectable type; only RedisPort is.
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, opts?: { ex?: number; px?: number; nx?: boolean }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, keys: string[], args: RedisEvalArg[]): Promise<unknown>;
  hget(key: string, field: string): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<unknown>;
  hexists(key: string, field: string): Promise<number>;
  hlen(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  smembers(key: string): Promise<unknown>;
  sismember(key: string, member: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  zcard(key: string): Promise<number>;
  ping(): Promise<string>;
}

/**
 * Raised by wrappers when a transport throw happened after the request was
 * written (`may-have-committed`) or before any write reached the wire
 * (`zero-write`). Wrappers must not translate `may-have-committed` into a
 * definite refusal status; clients replay the same idempotency key.
 */
export class RedisCommitAmbiguousError extends Error {
  readonly commitState: 'zero-write' | 'may-have-committed';

  constructor(commitState: 'zero-write' | 'may-have-committed', cause?: unknown) {
    super(`Redis commit ambiguous: ${commitState}`);
    this.name = 'RedisCommitAmbiguousError';
    this.commitState = commitState;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
