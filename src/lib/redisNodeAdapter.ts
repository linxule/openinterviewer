// node-redis adapter (dev/test only, Revision 12 §2).
// Production hosted/standalone continue to use the Upstash adapter in
// kvClient.ts. This adapter implements RedisPort and adds the disposable
// real-Redis fault harness surface: a brand derived from the exact
// `redis://` URL plus a runner-minted ownership token. Fault seams refuse
// unless the brand matches the runner-minted token; production adapters have
// no fault hook.

import { createClient } from 'redis';
import { createHash } from 'crypto';
import type { RedisClientOptions, RedisClientType } from 'redis';
import { RedisCommitAmbiguousError, type RedisEvalArg, type RedisPort } from './redisPort';

export const REDIS_BRAND_PREIMAGE_PREFIX = 'oi:redis-brand:v1';

/** sha256(`oi:redis-brand:v1` + 0x00 + exactUrl + 0x00 + ownershipToken). */
export function computeRedisBrand(exactUrl: string, ownershipToken: string): string {
  return createHash('sha256')
    .update(`${REDIS_BRAND_PREIMAGE_PREFIX}\u0000${exactUrl}\u0000${ownershipToken}`)
    .digest('hex');
}

export interface NodeRedisFaultSpec {
  /** Manifest cut id (tests/helpers/faultManifest.ts). */
  cutId: string;
  /** Command name(s) this fault intercepts: 'eval', 'set', 'hset', … */
  commands: string | readonly string[];
  /**
   * 'drop' rejects before the request is sent (never-sent, zero-write
   * simulation). 'throw' rejects before the request is sent with
   * errorMessage. 'loss' sends and commits the request, then rejects
   * (response loss, may-have-committed simulation). 'cut' rewrites a
   * named `-- fault cut <id>` production-script marker so the Lua
   * returns after that prefix (writes commit). 'undecodable' commits
   * then returns a coerced non-array so the wrapper fails closed.
   */
  effect: 'drop' | 'throw' | 'loss' | 'cut' | 'undecodable';
  errorMessage?: string;
  /**
   * For 'eval' only: intercept only when the script text matches this hint
   * (substring or RegExp). Ignored for other commands.
   */
  scriptHint?: string | RegExp;
  /** Single-shot by default; repeat while armed when false. */
  once?: boolean;
}

export interface RedisNodeAdapter extends RedisPort {
  /** sha256 brand, or null when no ownership token was minted. */
  readonly brand: string | null;
  readonly url: string;
  /** Fault seams require the brand (armFault throws otherwise). */
  armFault(spec: NodeRedisFaultSpec): void;
  clearFaults(): void;
  close(): Promise<void>;
}

export class RedisFaultDropError extends Error {
  readonly cutId: string;

  constructor(cutId: string) {
    super(`redis fault cut ${cutId}: request dropped before send (zero-write simulation)`);
    this.name = 'RedisFaultDropError';
    this.cutId = cutId;
  }
}

export class RedisFaultResponseLossError extends Error {
  readonly cutId: string;

  constructor(cutId: string) {
    super(`redis fault cut ${cutId}: response lost after commit (may-have-committed simulation)`);
    this.name = 'RedisFaultResponseLossError';
    this.cutId = cutId;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** node-redis returns booleans for HEXISTS/SISMEMBER/EXPIRE; RedisPort is numeric. */
export function asRedisCount(value: boolean | number): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Insert a committing Lua return after the last `-- fault cut <id>` marker.
 * Production scripts keep the comment as a no-op; only the branded adapter
 * rewrites the text for a single armed cut.
 */
export function injectNamedProductionFailpoint(script: string, cutId: string): string {
  const pattern = new RegExp(`-- fault cut[^\\n]*\\b${escapeRegExp(cutId)}\\b[^\\n]*`, 'g');
  const matches = [...script.matchAll(pattern)];
  if (matches.length === 0) {
    throw new Error(`Named production failpoint ${cutId} is missing from script`);
  }
  const last = matches[matches.length - 1]!;
  const at = last.index ?? 0;
  const end = at + last[0].length;
  return `${script.slice(0, end)}\ndo return {'oi:failpoint'} end${script.slice(end)}`;
}

export function createRedisNodeAdapter(options: {
  url: string;
  ownershipToken?: string;
  faults?: NodeRedisFaultSpec[];
  /** Test-only socket options (e.g. reconnectStrategy: () => false). */
  socket?: RedisClientOptions['socket'];
}): RedisNodeAdapter {
  const brand = options.ownershipToken
    ? computeRedisBrand(options.url, options.ownershipToken)
    : null;
  return new RedisNodeAdapterImpl(options.url, brand, options.faults ?? [], options.socket);
}

class RedisNodeAdapterImpl implements RedisPort {
  private readonly client: RedisClientType;
  readonly brand: string | null;
  readonly url: string;
  private faults: NodeRedisFaultSpec[] = [];
  private connected = false;

  constructor(
    url: string,
    brand: string | null,
    initialFaults: NodeRedisFaultSpec[],
    socket?: RedisClientOptions['socket']
  ) {
    this.url = url;
    this.brand = brand;
    this.faults = [...initialFaults];
    this.client = createClient({ url, socket });
  }

  private findFault(command: string, detail?: string): NodeRedisFaultSpec | undefined {
    if (this.faults.length === 0) return undefined;
    return this.faults.find((spec) => {
      const names = Array.isArray(spec.commands) ? spec.commands : [spec.commands];
      if (!names.some((name) => name.toLowerCase() === command.toLowerCase())) return false;
      if (spec.scriptHint !== undefined && detail !== undefined) {
        return typeof spec.scriptHint === 'string'
          ? detail.includes(spec.scriptHint)
          : spec.scriptHint.test(detail);
      }
      return true;
    });
  }

  private consumeFault(hit: NodeRedisFaultSpec): void {
    if (hit.once !== false) {
      this.faults = this.faults.filter((spec) => spec !== hit);
    }
  }

  private async ready(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  private async run<T>(
    command: string,
    execute: (script?: string) => Promise<T>,
    detail?: string
  ): Promise<T | undefined> {
    const hit = this.findFault(command, detail);
    if (hit) {
      this.consumeFault(hit);
      if (hit.effect === 'throw') {
        throw new Error(hit.errorMessage ?? `fault cut ${hit.cutId} injected (throw)`);
      }
      if (hit.effect === 'drop') {
        throw new RedisCommitAmbiguousError('zero-write', new RedisFaultDropError(hit.cutId));
      }
      if (hit.effect === 'cut') {
        if (command.toLowerCase() !== 'eval' || typeof detail !== 'string') {
          throw new Error(`fault cut ${hit.cutId}: 'cut' requires eval + production script text`);
        }
        const rewritten = injectNamedProductionFailpoint(detail, hit.cutId);
        await this.ready();
        return execute(rewritten);
      }
      // 'loss' / 'undecodable': send and commit, then lose or coerce the reply.
      await this.ready();
      const committed = await execute();
      if (hit.effect === 'undecodable') {
        return 1 as T;
      }
      throw new RedisCommitAmbiguousError(
        'may-have-committed',
        new RedisFaultResponseLossError(hit.cutId)
      );
    }
    await this.ready();
    return execute();
  }

  armFault(spec: NodeRedisFaultSpec): void {
    if (!this.brand) {
      throw new Error('Fault seams require a runner-minted ownership token (branded adapter)');
    }
    this.faults.push(spec);
  }

  clearFaults(): void {
    this.faults = [];
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return; // never-connected clients have nothing to close
    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }

  get<T = unknown>(key: string): Promise<T> {
    return this.run('get', () => this.client.get(key)) as Promise<T>;
  }

  set(key: string, value: string, opts?: { ex?: number; px?: number; nx?: boolean }): Promise<unknown> {
    return this.run('set', async () => {
      const options: Record<string, unknown> = {};
      if (opts?.nx) options.condition = 'NX';
      if (opts?.ex !== undefined) options.expiration = { type: 'EX', value: opts.ex };
      if (opts?.px !== undefined) options.expiration = { type: 'PX', value: opts.px };
      return this.client.set(key, value, options);
    });
  }

  del(...keys: string[]): Promise<number> {
    return this.run('del', () => this.client.del(keys)) as Promise<number>;
  }

  exists(...keys: string[]): Promise<number> {
    return this.run('exists', () => this.client.exists(keys)) as Promise<number>;
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.run('expire', async () => asRedisCount(await this.client.expire(key, seconds))) as Promise<number>;
  }

  eval(script: string, keys: string[], args: RedisEvalArg[]): Promise<unknown> {
    return this.run(
      'eval',
      (rewritten) => this.client.eval(rewritten ?? script, { keys, arguments: args }),
      script
    );
  }

  hget(key: string, field: string): Promise<unknown> {
    return this.run('hget', () => this.client.hGet(key, field));
  }

  hset(key: string, field: string, value: string): Promise<number> {
    return this.run('hset', () => this.client.hSet(key, field, value)) as Promise<number>;
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.run('hdel', () => this.client.hDel(key, fields)) as Promise<number>;
  }

  hgetall(key: string): Promise<unknown> {
    return this.run('hgetall', () => this.client.hGetAll(key));
  }

  hexists(key: string, field: string): Promise<number> {
    return this.run('hexists', async () => asRedisCount(await this.client.hExists(key, field))) as Promise<number>;
  }

  hlen(key: string): Promise<number> {
    return this.run('hlen', () => this.client.hLen(key)) as Promise<number>;
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.run('sadd', () => this.client.sAdd(key, members)) as Promise<number>;
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.run('srem', () => this.client.sRem(key, members)) as Promise<number>;
  }

  scard(key: string): Promise<number> {
    return this.run('scard', () => this.client.sCard(key)) as Promise<number>;
  }

  smembers(key: string): Promise<unknown> {
    return this.run('smembers', () => this.client.sMembers(key));
  }

  sismember(key: string, member: string): Promise<number> {
    return this.run('sismember', async () => asRedisCount(await this.client.sIsMember(key, member))) as Promise<number>;
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    return this.run('zadd', () => this.client.zAdd(key, { score, value: member })) as Promise<number>;
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    return this.run('zrem', () => this.client.zRem(key, members)) as Promise<number>;
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.run('zscore', async () => {
      const score = await this.client.zScore(key, member);
      return score === null ? null : String(score);
    }) as Promise<string | null>;
  }

  zcard(key: string): Promise<number> {
    return this.run('zcard', () => this.client.zCard(key)) as Promise<number>;
  }

  ping(): Promise<string> {
    return this.run('ping', () => this.client.ping()) as Promise<string>;
  }
}
