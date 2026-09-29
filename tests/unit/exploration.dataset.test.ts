// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStudyConfig } from '../fixtures/models';
import type { StoredInterview } from '@/types';
import { assertExplorationCorpus, buildDatasetDescription, immutableSourceContentHash, loadStudyDataset, matchRecordedProfileFilter } from '@/lib/exploration/dataset';

const config = makeStudyConfig({ id: 'study-a', createdAt: 1, profileSchema: [
  { id: 'age', label: 'Age in years', extractionHint: 'Recorded age in years', required: false },
] });

function record(id: string, value: string | null, status: 'extracted' | 'vague' | 'refused' | 'pending' = 'extracted'): StoredInterview {
  return makeStoredInterview({ id, studyId: config.id, studyRevision: 1, collectionConfig: config,
    participantProfile: { id: `profile-${id}`, fields: [{ fieldId: 'age', value, status }], rawContext: '', timestamp: 1 },
    transcript: [{ id: 't-1', role: 'user', content: 'Synthetic overlooked concern about access.', timestamp: 1 }],
  });
}

describe('explicit exploration dataset', () => {
  it('includes saved pending/failed analysis transcripts and reports unknown demographic values honestly', async () => {
    const interviews = [record('known', '29'), record('band', '20–30'), record('vague', '29', 'vague'),
      record('refused', null, 'refused'), record('missing', null, 'pending'), record('older', '42'),
      { ...record('legacy', '29'), collectionConfig: undefined }];
    const result = await buildDatasetDescription(config.id, interviews, {
      filters: [{ fieldId: 'age', operator: 'number-between', minimum: 20, maximum: 30 }],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.interviews.map(interview => interview.id)).toEqual(['known']);
    expect(result.description.manifest).toMatchObject({ totalSaved: 7, selectedCount: 1, excludedCount: 6,
      unknownProfileCount: 5, pendingAnalysisCount: 1 });
    expect(result.description.historicalProfileUnknownCount).toBe(1);
  });

  it('never parses numeric intervals, units, words or demographic inference as a scalar number', () => {
    const filter = { fieldId: 'age', operator: 'number-between' as const, minimum: 20, maximum: 30 };
    for (const value of ['20-30', '20s', '29 years', 'young adult', 'twenty-nine', '2e1', '29,0']) {
      expect(matchRecordedProfileFilter(record('a', value), filter)).toBe('unknown');
    }
    expect(matchRecordedProfileFilter(record('a', ' 29.5 '), filter)).toBe('match');
    expect(matchRecordedProfileFilter(record('a', '31'), filter)).toBe('excluded');
  });

  it('keeps repurposed historical field IDs unknown until the researcher narrows the revision', async () => {
    const first = record('a', '29');
    const second = { ...record('b', '29'), studyRevision: 2, collectionConfig: { ...config,
      profileSchema: [{ ...config.profileSchema[0], label: 'Years of employment', extractionHint: 'Tenure' }],
    } };
    const filters = [{ fieldId: 'age', operator: 'equals' as const, value: '29' }];
    const mixed = await buildDatasetDescription(config.id, [first, second], { filters });
    expect(mixed.status).toBe('ok');
    if (mixed.status === 'ok') {
      expect(mixed.description.profileFields).toEqual([]);
      expect(mixed.description.ambiguousProfileFieldIds).toEqual(['age']);
      expect(mixed.description.manifest).toMatchObject({ selectedCount: 0, unknownProfileCount: 2 });
    }
    const narrowed = await buildDatasetDescription(config.id, [first, second], { revisions: [1], filters });
    expect(narrowed.status === 'ok' && narrowed.interviews.map(interview => interview.id)).toEqual(['a']);
    expect(narrowed.status === 'ok' && narrowed.description.ambiguousProfileFieldIds).toEqual([]);
  });

  it('uses deterministic source hashes unaffected by mutable analysis state, but bound to original profiles/config', async () => {
    const original = record('a', '29');
    const changedAnalysis = { ...original, analysis: { status: 'failed' as const, generation: 2,
      attempts: 2, lastAttemptAt: 50, failureKind: 'provider' as const }, aiModel: 'new-served-model' };
    expect(await immutableSourceContentHash(original)).toBe(await immutableSourceContentHash(changedAnalysis));
    expect(await immutableSourceContentHash(original)).not.toBe(await immutableSourceContentHash(record('a', '30')));
    expect(await immutableSourceContentHash(original)).not.toBe(await immutableSourceContentHash({ ...original,
      collectionConfig: { ...config, description: 'A different original protocol' } }));
    const left = await buildDatasetDescription(config.id, [record('b', '30'), original], { interviewIds: ['b', 'a'] });
    const right = await buildDatasetDescription(config.id, [original, record('b', '30')], { interviewIds: ['a', 'b'] });
    expect(left.status === 'ok' && left.description.manifest.sourceFingerprint)
      .toBe(right.status === 'ok' && right.description.manifest.sourceFingerprint);
  });

  it('refuses foreign/missing identities instead of silently shrinking the selection', async () => {
    expect(await buildDatasetDescription(config.id, [{ ...record('a', '29'), studyId: 'other-study' }]))
      .toEqual({ status: 'unavailable' });
    expect(await buildDatasetDescription(config.id, [record('a', '29')], { interviewIds: ['other-record'] }))
      .toEqual({ status: 'invalid-selection', reason: 'unknown-interview' });
    expect(await buildDatasetDescription(config.id, [record('a', '29')], { interviewIds: [] }))
      .toMatchObject({ status: 'ok', description: { manifest: { selectedCount: 0, excludedCount: 1 } } });
  });

  it('retains the existing finite nonnegative saved-turn timestamp contract without normalizing source values', async () => {
    const ordinary = record('ordinary', '29');
    for (const timestamp of [1.5, Number.MAX_VALUE]) {
      const historical = { ...record('historical', '29'),
        transcript: [{ id: 't-1', role: 'user' as const, content: 'A synthetic historical source.', timestamp }],
      };
      const all = await buildDatasetDescription(config.id, [ordinary, historical]);
      expect(all.status).toBe('ok');
      if (all.status === 'ok') {
        expect(all.interviews.find(interview => interview.id === historical.id)?.transcript[0].timestamp).toBe(timestamp);
      }
      const excluding = await buildDatasetDescription(config.id, [ordinary, historical], { interviewIds: [ordinary.id] });
      expect(excluding.status === 'ok' && excluding.interviews.map(interview => interview.id)).toEqual([ordinary.id]);
      const normalized = { ...historical, transcript: [{ ...historical.transcript[0], timestamp: 1 }] };
      expect(await immutableSourceContentHash(historical)).not.toBe(await immutableSourceContentHash(normalized));
    }
  });

  it('separates bounded dataset inspection from full-transcript execution limits', async () => {
    const large = Array.from({ length: 101 }, (_, index) => record(`record-${index}`, '29'));
    expect((await buildDatasetDescription(config.id, large)).status).toBe('ok');
    expect(assertExplorationCorpus(large)).toMatchObject({ status: 'too-large', reason: 'interviews', actual: 101 });
    const long = { ...record('long', '29'), transcript: [{ id: 't-1', role: 'user' as const, content: '汉'.repeat(25_000), timestamp: 1 }] };
    expect(assertExplorationCorpus([long])).toMatchObject({ status: 'too-large', reason: 'bytes' });
    expect(assertExplorationCorpus([])).toEqual({ status: 'empty' });
  });

  it('uses only a bounded study-scoped portable read and propagates oversize/storage failures', async () => {
    const listInterviews = vi.fn(async () => ({ status: 'too-large' as const, count: 1001, maximum: 1000 }));
    expect(await loadStudyDataset({ studyId: config.id, store: { listInterviews } }))
      .toEqual({ status: 'too-large', count: 1001, maximum: 1000 });
    expect(listInterviews).toHaveBeenCalledExactlyOnceWith({ scope: 'study', studyId: config.id, maximum: 1000 });
    listInterviews.mockRejectedValueOnce(new Error('unavailable'));
    expect(await loadStudyDataset({ studyId: config.id, store: { listInterviews } })).toEqual({ status: 'unavailable' });
  });
});
