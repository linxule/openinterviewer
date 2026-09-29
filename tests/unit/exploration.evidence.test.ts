// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { makeStoredInterview } from '../fixtures/models';
import { buildDatasetDescription } from '@/lib/exploration/dataset';
import { resolveExplorationEvidenceRef, resolveExplorationPayload, resolveManifestSources, summarizeExplorationEvidence } from '@/lib/exploration/evidence';

const interviews = [makeStoredInterview({ id: 'interview-a', studyId: 'study-a', transcript: [
  { id: 'a-1', role: 'ai', content: 'I cannot use this tool.', timestamp: 1 },
  { id: 'a-2', role: 'user', content: 'I can’t open the dashboard, but export works well.', timestamp: 1 },
] })];

describe('exploration evidence is an inspectable claim', () => {
  it('maps server identities and retains wrong-speaker, fabricated and out-of-range claims unverified', () => {
    const response = resolveExplorationPayload({ answer: 'A qualified finding.', limitations: ['One source.'], findings: [{
      heading: 'Access', interpretation: 'Evidence cuts both ways.',
      supporting: [{ interviewIndex: 1, turnIndex: 2, quote: "I can't open the dashboard" }],
      challenging: [{ interviewIndex: 1, turnIndex: 1, quote: 'I cannot use this tool.' }],
      uncertain: [{ interviewIndex: 1, turnIndex: 2, quote: 'It deleted all my work.' },
        { interviewIndex: 2, turnIndex: 2, quote: 'Another supposed participant.' }],
    }] }, interviews);
    expect(response.findings[0].supporting[0].interviewId).toBe('interview-a');
    expect(response.findings[0].uncertain[1].interviewId).toBeUndefined();
    const coverage = summarizeExplorationEvidence(response, interviews, 'study-a');
    expect(coverage).toMatchObject({ verifiedQuoteCount: 1, unverifiedQuoteCount: 3, quotedInterviewIds: ['interview-a'] });
    expect(coverage.entries[0].quotedFromRecord).toBe('I can’t open the dashboard');
    expect(coverage.entries.slice(1).map(entry => entry.match)).toEqual([
      { status: 'unverified', reason: 'wrong-speaker' }, { status: 'unverified', reason: 'not-found' },
      { status: 'unverified', reason: 'no-record' },
    ]);
    expect(response.findings[0].uncertain[0].quote).toBe('It deleted all my work.');
  });

  it('never resolves a source from another study under a matching ID', () => {
    expect(resolveExplorationEvidenceRef({ interviewId: 'interview-a', turnIndex: 2, quote: 'export works well' },
      [{ ...interviews[0], studyId: 'other-study' }], 'study-a').match)
      .toEqual({ status: 'unverified', reason: 'no-record' });
  });

  it('renders historical citations only from exact immutable scope, not newly edited or missing records', async () => {
    const dataset = await buildDatasetDescription('study-a', interviews);
    expect(dataset.status).toBe('ok');
    if (dataset.status !== 'ok') return;
    expect(await resolveManifestSources(dataset.description.manifest, interviews))
      .toEqual({ interviews, unavailableInterviewIds: [] });
    const changed = [{ ...interviews[0], transcript: [{ ...interviews[0].transcript[1], content: 'Changed source.' }] }];
    expect(await resolveManifestSources(dataset.description.manifest, changed))
      .toEqual({ interviews: [], unavailableInterviewIds: ['interview-a'] });
    expect(await resolveManifestSources(dataset.description.manifest, []))
      .toEqual({ interviews: [], unavailableInterviewIds: ['interview-a'] });
  });
});
