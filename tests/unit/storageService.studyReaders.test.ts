// The checked study readers (UI-CF-02/04): every failure is a typed outcome,
// never an empty list or a missing study, so a page can keep what it shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { getAllStudies, readStudy, readStudyAggregate, readStudyInterviews } from '@/services/storageService';
import { toStudyListItem, type PendingStudyStub } from '@/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('readStudyInterviews', () => {
  it('confirms a list, including an empty one, and encodes the study id', async () => {
    const interview = makeStoredInterview({ id: 'session-1', studyId: 'study a' });
    const fetchMock = reply({ interviews: [interview] });
    await expect(readStudyInterviews('study a')).resolves.toEqual({ status: 'ok', value: [interview] });
    expect(fetchMock).toHaveBeenCalledWith('/api/interviews?studyId=study%20a', undefined);

    reply({ interviews: [] });
    await expect(readStudyInterviews('study-a')).resolves.toEqual({ status: 'ok', value: [] });
  });

  it.each<[number, unknown, unknown]>([
    [413, { error: 'This study has too much interview data to list at once.' },
      { status: 'too-large', error: 'This study has too much interview data to list at once.' }],
    [401, { error: 'Unauthorized' }, { status: 'unauthorized', error: 'Unauthorized' }],
    [404, { error: 'Study not found' }, { status: 'not-found', error: 'Study not found' }],
    [500, { error: 'Failed to fetch interviews' }, { status: 'error', error: 'Failed to fetch interviews' }],
    [503, { error: 'Interview storage is temporarily unavailable.' },
      { status: 'unavailable', error: 'Interview storage is temporarily unavailable.', retryable: true }],
    [409, { code: 'STUDY_OPERATION_PENDING', error: 'A study operation is already in progress.' },
      { status: 'pending', error: 'A study operation is already in progress.' }],
  ])('classifies HTTP %s without inventing an empty list', async (status, body, expected) => {
    reply(body, status);
    await expect(readStudyInterviews('study-a')).resolves.toEqual(expected);
  });

  it('reports a network failure as retryable unavailability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(readStudyInterviews('study-a')).resolves.toEqual({
      status: 'unavailable',
      error: 'Interview storage is temporarily unavailable.',
      retryable: true,
    });
  });

  it('does not treat a success without a list as an empty list', async () => {
    reply({});
    await expect(readStudyInterviews('study-a')).resolves.toEqual({
      status: 'error',
      error: 'The interview list could not be read.',
    });
  });
});

describe('readStudy', () => {
  it('returns the study, and not-found only for a 404 or a hosted 403', async () => {
    const study = makeStoredStudy({ id: 'study-a' });
    reply({ study });
    await expect(readStudy('study-a')).resolves.toEqual({ status: 'ok', value: study });

    reply({ error: 'Study not found' }, 404);
    await expect(readStudy('study-a')).resolves.toEqual({ status: 'not-found', error: 'Study not found' });

    // Hosted answers 403 for another researcher's study: reported with the
    // missing-study text, never the server's, so the two cannot be told apart.
    reply({ error: 'Forbidden' }, 403);
    await expect(readStudy('study-a')).resolves.toEqual({ status: 'not-found', error: 'Study not found' });

    reply({ error: 'Failed to fetch study' }, 500);
    await expect(readStudy('study-a')).resolves.toEqual({ status: 'error', error: 'Failed to fetch study' });

    reply({});
    await expect(readStudy('study-a')).resolves.toEqual({ status: 'error', error: 'The study could not be read.' });
  });
});

describe('readStudyAggregate', () => {
  it('distinguishes "no aggregate yet" from a failed read', async () => {
    const fetchMock = reply({ aggregate: null });
    await expect(readStudyAggregate('study-a')).resolves.toEqual({ status: 'ok', value: null });
    expect(fetchMock).toHaveBeenCalledWith('/api/studies/study-a/aggregate', { cache: 'no-store' });

    reply({ error: 'Analysis storage is temporarily unavailable.' }, 503);
    await expect(readStudyAggregate('study-a')).resolves.toEqual({
      status: 'unavailable',
      error: 'Analysis storage is temporarily unavailable.',
      retryable: true,
    });
  });
});

describe('getAllStudies (ST-08)', () => {
  const pending: PendingStudyStub = { id: 'pending-1', reconciliationPending: true, operationId: 'op-1', phase: 'begun' };

  it('asks for the summary view and passes list items and pending studies through', async () => {
    const item = toStudyListItem(makeStoredStudy({ config: makeStudyConfig({ coreQuestions: ['One?'] }) }));
    const fetchMock = reply({ studies: [pending, item], pendingStudies: [pending] });

    const listed = await getAllStudies();
    expect(fetchMock).toHaveBeenCalledWith('/api/studies?view=summary');
    expect(listed.studies).toEqual([pending, item]);
    expect(listed.outcome).toEqual({ status: 'ok', value: { studies: [pending, item], pendingStudies: [pending] } });
  });

  it('projects whole studies from a server that predates the summary view', async () => {
    const study = makeStoredStudy({ config: makeStudyConfig({ coreQuestions: ['One?', 'Two?', 'Three?'] }) });
    reply({ studies: [pending, study], pendingStudies: [pending] });

    const listed = await getAllStudies();
    expect(listed.studies).toEqual([pending, JSON.parse(JSON.stringify(toStudyListItem(study)))]);
    expect(listed.studies[1]).toMatchObject({ coreQuestionCount: 3 });
  });
});
