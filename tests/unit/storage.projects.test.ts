// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRedisProjectsStore } from '@/lib/storage/redisProjects';
import { createRedisWorkspaceStore } from '@/lib/storage/redis';
import { createDurableWorkspaceStore } from '@/lib/storage/durableObject';
import { RedisCommitAmbiguousError, type RedisPort } from '@/lib/redisPort';
const id = '00000000-0000-4000-8000-000000000001';
const project = { id, name: 'Test', createdAt: 1, updatedAt: 1 };
function redis(reply: unknown) {
  const evaluate = vi.fn().mockResolvedValue(reply);
  return { store: createRedisProjectsStore({ eval: evaluate } as unknown as RedisPort, () => {}), evaluate };
}
function durable(reply: unknown) {
  const method = vi.fn().mockResolvedValue(reply);
  const store = createDurableWorkspaceStore({ namespace: { getByName: () => new Proxy({}, { get: () => method }) },
    workspaceId: 'ws_' + 'a'.repeat(32), jurisdiction: '', rateLimitSalt: 'synthetic-salt' });
  return { store: store.projects, method };
}
describe('project storage boundaries', () => {
  it('decodes tagged Redis arrays including truly empty collections', async () => {
    expect(await redis(['oi:ok', 'oi:json:[]', 'oi:json:[]', 'oi:json:[]']).store.list())
      .toEqual({ status: 'ok', projects: [], memberships: [], studyIds: [] });
    const { store, evaluate } = redis(null);
    evaluate.mockImplementation(async (_script, _keys, args) => ['oi:created', 'oi:json:' + JSON.stringify({ ...project, id: args[1] })]);
    expect(await store.create({ name: ' Test ' })).toMatchObject({ status: 'created', project: { name: 'Test' } });
  });
  it.each([null, ['created'], ['oi:deleted', 'extra'], ['oi:created', 'oi:json:{}'], ['oi:ok']])('malformed write reply is ambiguous, never success: %j', async reply => {
    expect(await redis(reply).store.create({ name: 'Test' })).toEqual({ status: 'ambiguous' });
  });
  it('distinguishes zero-write transport errors from uncertain commits without retrying', async () => {
    for (const commitState of ['zero-write', 'may-have-committed'] as const) {
      const { store, evaluate } = redis(null);
      evaluate.mockRejectedValue(new RedisCommitAmbiguousError(commitState));
      expect(await store.create({ name: 'Test' })).toEqual({ status: commitState === 'zero-write' ? 'unavailable' : 'ambiguous' });
      expect(evaluate).toHaveBeenCalledTimes(1);
    }
  });
  it('Durable validates payloads, statuses and requested identities, with safe old-RPC failures', async () => {
    expect(await durable({ status: 'found', project, studyIds: [] }).store.read({ projectId: id })).toMatchObject({ status: 'found' });
    expect(await durable({ status: 'found', project, studyIds: [] }).store.read({ projectId: crypto.randomUUID() })).toEqual({ status: 'unavailable' });
    expect(await durable({ status: 'assigned', studyId: 'other', projectId: id }).store.assignStudy({ studyId: 's', projectId: id })).toEqual({ status: 'ambiguous' });
    const { store, method } = durable(null);
    method.mockRejectedValue(new Error('RPC missing'));
    expect(await store.list()).toEqual({ status: 'unavailable' });
    expect(await store.delete({ projectId: id })).toEqual({ status: 'ambiguous' });
    expect(method).toHaveBeenCalledTimes(2);
  });
  it('every hosted project operation refuses before any Redis command', async () => {
    const command = vi.fn(() => { throw new Error('Redis must not be reached'); });
    const store = createRedisWorkspaceStore(new Proxy({}, { get: () => command }) as RedisPort, { researcherId: 'hosted-owner' }).projects;
    for (const call of [() => store.list(), () => store.read({ projectId: id }), () => store.create({ name: 'Test' }),
      () => store.rename({ projectId: id, name: 'Test' }), () => store.delete({ projectId: id }),
      () => store.assignStudy({ studyId: 's', projectId: null })]) await expect(call()).rejects.toMatchObject({ operation: 'projects' });
    expect(command).not.toHaveBeenCalled();
  });
});
