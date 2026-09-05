// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { RedisCommitAmbiguousError } from '@/lib/redisPort';
import type { RedisPort } from '@/lib/redisPort';
import {
  REPLACE_STUDY_CONFIG_SCRIPT,
  SET_STUDY_LINKS_SCRIPT,
  encodeMutationGuard,
  replaceStudyConfigAtomic,
  setStudyLinksEnabled,
} from '@/lib/kv';
import { parseStudyCasResult } from '@/lib/wire/studyCas';
import { makeStoredStudy } from '../fixtures/models';

class MemoryCasRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  writes: string[] = [];
  lastScript = '';
  lastKeys: string[] = [];
  evalError: unknown | undefined;

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.lastScript = script;
    this.lastKeys = keys;
    if (this.evalError) throw this.evalError;
    return this.run(script, keys, args);
  }

  private decodeStudy(raw: string | undefined): { study: Record<string, unknown>; prefixed: boolean } | null {
    if (!raw) return null;
    const prefixed = raw.startsWith('oi:study:');
    const payload = prefixed ? raw.slice('oi:study:'.length) : raw;
    try {
      const study = JSON.parse(payload) as Record<string, unknown>;
      if (!study || typeof study !== 'object') return null;
      return { study, prefixed };
    } catch {
      return null;
    }
  }

  private run(script: string, keys: string[], args: string[]): unknown {
    if ((this.sets.get(keys[1])?.size ?? 0) > 0) return ['oi:persist-guard'];
    const guardRaw = this.strings.get(keys[2]);
    if (guardRaw) {
      if (!guardRaw.startsWith('oi:smg:')) return ['oi:byos-unavailable'];
      const mutation = JSON.parse(guardRaw.slice('oi:smg:'.length)) as { state?: string };
      if (mutation.state !== 'created') return ['oi:persist-guard'];
    }
    const decoded = this.decodeStudy(this.strings.get(keys[0]));
    if (!decoded) return ['oi:not-found'];
    const study = decoded.study;
    if (script.includes('pcall(cjson.decode, ARGV[2])')) {
      if ((Number(study.revision) || 1) !== Number(args[0])) {
        return ['oi:conflict', `oi:revision:${Math.floor(Number(study.revision) || 1)}`];
      }
      study.config = JSON.parse(args[1]) as Record<string, unknown>;
      study.updatedAt = Number(args[2]);
    } else {
      const config = (study.config && typeof study.config === 'object'
        ? study.config
        : {}) as Record<string, unknown>;
      config.linksEnabled = args[0] === '1';
      study.config = config;
      study.updatedAt = Number(args[1]);
    }
    study.revision = (Number(study.revision) || 1) + 1;
    const encoded = JSON.stringify(study);
    this.strings.set(keys[0], decoded.prefixed ? `oi:study:${encoded}` : encoded);
    this.writes.push('cas-updated');
    return ['oi:updated', `oi:json:${encoded}`];
  }
}

function asPort(memory: MemoryCasRedis): RedisPort {
  return memory as unknown as RedisPort;
}

describe('BYOS config/link serialization', () => {
  it('serializes config replace through the T0c.1 grammar and preserves unprefixed study bodies', async () => {
    const memory = new MemoryCasRedis();
    const study = makeStoredStudy({ id: 'study-cas', revision: 4, interviewCount: 2, isLocked: true });
    memory.strings.set(`study:${study.id}`, JSON.stringify(study));

    const result = await replaceStudyConfigAtomic(
      study.id,
      4,
      { ...study.config, name: 'Renamed' },
      asPort(memory),
    );
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.study.config.name).toBe('Renamed');
      expect(result.study.revision).toBe(5);
      expect(result.study.interviewCount).toBe(2);
      expect(result.study.isLocked).toBe(true);
    }
    expect(memory.strings.get(`study:${study.id}`)?.startsWith('{"id"')).toBe(true);
    expect(REPLACE_STUDY_CONFIG_SCRIPT).toContain("return {'oi:updated', 'oi:json:' .. updatedJson}");
    expect(parseStudyCasResult(['oi:updated', `oi:json:${JSON.stringify(study)}`]).status).toBe('ok');
  });

  it('preserves oi:study: bodies on link toggle and refuses live persist or non-created guards', async () => {
    const memory = new MemoryCasRedis();
    const study = makeStoredStudy({ id: 'study-cas', revision: 1 });
    memory.strings.set(`study:${study.id}`, `oi:study:${JSON.stringify(study)}`);

    const updated = await setStudyLinksEnabled(study.id, false, asPort(memory));
    expect(updated.status).toBe('updated');
    expect(memory.strings.get(`study:${study.id}`)?.startsWith('oi:study:')).toBe(true);

    memory.sets.set(`study-persisting:${study.id}`, new Set(['iv-1']));
    await expect(setStudyLinksEnabled(study.id, true, asPort(memory))).resolves.toEqual({
      status: 'persist-guard',
    });
    memory.sets.delete(`study-persisting:${study.id}`);

    memory.strings.set(
      `study-mutation-guard:${study.id}`,
      encodeMutationGuard({
        version: 2,
        studyId: study.id,
        kind: 'delete',
        generation: 1,
        state: 'in-flight',
        markerId: `delete:${study.id}:0`,
      }),
    );
    await expect(replaceStudyConfigAtomic(study.id, 2, study.config, asPort(memory))).resolves.toEqual({
      status: 'persist-guard',
    });
    expect(memory.writes.filter((item) => item === 'cas-updated')).toHaveLength(1);
    expect(SET_STUDY_LINKS_SCRIPT).toContain("if mutation.state ~= 'created' then");
  });

  it('maps revision mismatch, not-found, malformed numeric tuples, and may-have-committed exactly', async () => {
    const memory = new MemoryCasRedis();
    const study = makeStoredStudy({ id: 'study-cas', revision: 9 });
    memory.strings.set(`study:${study.id}`, JSON.stringify(study));

    await expect(replaceStudyConfigAtomic(study.id, 8, study.config, asPort(memory))).resolves.toEqual({
      status: 'conflict',
    });
    await expect(replaceStudyConfigAtomic('missing-study', 1, study.config, asPort(memory))).resolves.toEqual({
      status: 'not-found',
    });
    expect(parseStudyCasResult([0]).status).toBe('unavailable');
    expect(parseStudyCasResult([1, study]).status).toBe('unavailable');

    memory.evalError = new RedisCommitAmbiguousError('may-have-committed');
    await expect(setStudyLinksEnabled(study.id, false, asPort(memory))).resolves.toEqual({
      status: 'ambiguous',
    });
  });
});
