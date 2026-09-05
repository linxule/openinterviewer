// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { RedisPort } from '@/lib/redisPort';
import {
  AGGREGATE_VALUE_PREFIX,
  getStudyAggregateChecked,
  MAX_STORED_AGGREGATE_BYTES,
  saveStudyAggregate,
  STUDY_AGGREGATE_PREFIX,
} from '@/lib/kv';
import type { StoredAggregateSynthesis } from '@/types';

function fixtureAggregate(overrides: Partial<StoredAggregateSynthesis> = {}): StoredAggregateSynthesis {
  return {
    studyId: 'study-a',
    studyRevision: 4,
    interviewIds: ['interview-a', 'interview-b'],
    interviewCount: 2,
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash',
    commonThemes: [],
    divergentViews: [],
    keyFindings: ['A finding'],
    researchImplications: ['An implication'],
    bottomLine: 'A bottom line.',
    generatedAt: 1_700_000_000_000,
    savedAt: 1_700_000_001_000,
    ...overrides,
  };
}

describe('aggregate synthesis persistence', () => {
  it('writes with the expected key and value prefix, and returns saved', async () => {
    const setMock = vi.fn().mockResolvedValue('OK');
    const client = { set: setMock } as unknown as RedisPort;
    const aggregate = fixtureAggregate();

    await expect(saveStudyAggregate(aggregate, client)).resolves.toBe('saved');

    expect(setMock).toHaveBeenCalledTimes(1);
    const [key, value] = setMock.mock.calls[0] as [string, string];
    expect(key).toBe(`${STUDY_AGGREGATE_PREFIX}study-a`);
    expect(value.startsWith(AGGREGATE_VALUE_PREFIX)).toBe(true);
  });

  it('round-trips a deep-equal record through getStudyAggregateChecked', async () => {
    const aggregate = fixtureAggregate();
    let stored: string | null = null;
    const client = {
      set: vi.fn().mockImplementation(async (_key: string, value: string) => {
        stored = value;
        return 'OK';
      }),
      get: vi.fn().mockImplementation(async () => stored),
    } as unknown as RedisPort;

    await expect(saveStudyAggregate(aggregate, client)).resolves.toBe('saved');
    await expect(getStudyAggregateChecked('study-a', client)).resolves.toEqual({
      status: 'found',
      aggregate,
    });
  });

  it('treats a value written for one study as not-found when read as another (mixup guard)', async () => {
    const aggregate = fixtureAggregate({ studyId: 'study-a' });
    const client = {
      get: vi.fn().mockResolvedValue(`${AGGREGATE_VALUE_PREFIX}${JSON.stringify(aggregate)}`),
    } as unknown as RedisPort;

    await expect(getStudyAggregateChecked('study-b', client)).resolves.toEqual({ status: 'not-found' });
  });

  it('decodes a record carrying _receipt as not-found', async () => {
    const aggregate = { ...fixtureAggregate(), _receipt: 'stray-receipt' };
    const client = {
      get: vi.fn().mockResolvedValue(`${AGGREGATE_VALUE_PREFIX}${JSON.stringify(aggregate)}`),
    } as unknown as RedisPort;

    await expect(getStudyAggregateChecked('study-a', client)).resolves.toEqual({ status: 'not-found' });
  });

  it('decodes a record whose interviewCount disagrees with interviewIds.length as not-found', async () => {
    const aggregate = fixtureAggregate({ interviewCount: 5 });
    const client = {
      get: vi.fn().mockResolvedValue(`${AGGREGATE_VALUE_PREFIX}${JSON.stringify(aggregate)}`),
    } as unknown as RedisPort;

    await expect(getStudyAggregateChecked('study-a', client)).resolves.toEqual({ status: 'not-found' });
  });

  it.each([
    ['a non-prefixed string', 'not-an-aggregate-value'],
    ['a JSON array', JSON.stringify(['not', 'an', 'object'])],
    ['a bare object', JSON.stringify({ foo: 'bar' })],
    ['null', null],
  ])('decodes %s as not-found', async (_label, raw) => {
    const client = { get: vi.fn().mockResolvedValue(raw) } as unknown as RedisPort;

    await expect(getStudyAggregateChecked('study-a', client)).resolves.toEqual({ status: 'not-found' });
  });

  it('yields unavailable when the read throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { get: vi.fn().mockRejectedValue(new Error('down')) } as unknown as RedisPort;

    await expect(getStudyAggregateChecked('study-a', client)).resolves.toEqual({ status: 'unavailable' });
    errorSpy.mockRestore();
  });

  it('returns unavailable when the write throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { set: vi.fn().mockRejectedValue(new Error('down')) } as unknown as RedisPort;

    await expect(saveStudyAggregate(fixtureAggregate(), client)).resolves.toBe('unavailable');
    errorSpy.mockRestore();
  });

  it('refuses an oversized aggregate before touching the client', async () => {
    const setMock = vi.fn();
    const client = { set: setMock } as unknown as RedisPort;
    const oversized = fixtureAggregate({
      keyFindings: [new Array(MAX_STORED_AGGREGATE_BYTES).fill('x').join('')],
    });

    await expect(saveStudyAggregate(oversized, client)).resolves.toBe('too-large');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed studyId with no client call', async () => {
    const setMock = vi.fn();
    const client = { set: setMock } as unknown as RedisPort;
    const aggregate = fixtureAggregate({ studyId: '../not-an-id' });

    await expect(saveStudyAggregate(aggregate, client)).resolves.toBe('unavailable');
    expect(setMock).not.toHaveBeenCalled();
  });
});
