import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import type { DatasetDescription, ExplorationAnswer } from '@/lib/exploration/types';
import { immutableSourceContentHash } from '@/lib/exploration/dataset';
import { StudyExploration } from '@/components/StudyExploration';
import { ExplorationApiError } from '@/services/explorationApi';

const api = vi.hoisted(() => ({ describeStudyDataset: vi.fn(), askStudyQuestion: vi.fn(), listStudyExplorationsPage: vi.fn(), readStudyExploration: vi.fn(), saveStudyExploration: vi.fn() }));
vi.mock('@/services/explorationApi', async importOriginal => ({ ...await importOriginal<typeof import('@/services/explorationApi')>(), ...api }));
const storage = vi.hoisted(() => ({ getInterview: vi.fn() }));
vi.mock('@/services/storageService', async importOriginal => ({ ...await importOriginal<typeof import('@/services/storageService')>(), ...storage }));

const study = makeStoredStudy({ id: 'study-explore', config: makeStudyConfig({ id: 'study-explore', name: 'Evidence study' }), revision: 2 });
const interview = makeStoredInterview({ id: 'failed-analysis', studyId: study.id, studyRevision: 1, synthesis: null, transcript: [{ id: 'ai', role: 'ai', content: 'What concerned you?', timestamp: 10 }, { id: 'user', role: 'user', content: 'The application assumes I always have internet access.', timestamp: 20 }] });
const dataset: DatasetDescription = { manifest: { studyId: study.id, selection: {}, sources: [{ interviewId: interview.id, studyRevision: 1, contentHash: 'a'.repeat(64) }], totalSaved: 3, selectedCount: 1, excludedCount: 2, unknownProfileCount: 1, pendingAnalysisCount: 1, sourceFingerprint: 'b'.repeat(64) }, revisions: [{ revision: 1, count: 3, analyzedCount: 0 }], profileFields: [{ id: 'age', label: 'Age at collection', required: false, extractionHint: 'Recorded age' }], historicalProfileUnknownCount: 1 };
const answer: ExplorationAnswer = { id: 'answer-one', studyId: study.id, question: 'What unexpected concern was overlooked?', scope: dataset.manifest, createdAt: 1000, updatedAt: 1001, status: 'complete', requestFingerprint: 'c'.repeat(64), promptVersion: 1, execution: { provider: 'gemini', requestedModel: 'gemini-fixture', model: 'gemini-fixture' }, result: { answer: 'Offline access is an overlooked concern.', findings: [{ heading: 'Connectivity assumptions', interpretation: 'The selected participant questioned a constant-connection assumption.', supporting: [{ interviewId: interview.id, turnIndex: 2, quote: 'I always have internet access' }], challenging: [], uncertain: [] }], limitations: ['One selected interview cannot establish prevalence.'] } };
const renderExplore = () => render(<StudyExploration study={study} interviews={[interview]} disabled={false} onDatasetApply={vi.fn()} />);
async function applyAndAsk() {
  await screen.findByRole('button', { name: 'Apply dataset selection' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dataset selection' }));
  await waitFor(() => expect(screen.queryByText('Apply a dataset selection before asking a question.')).not.toBeInTheDocument());
  fireEvent.change(screen.getByRole('textbox', { name: 'Question for these interviews' }), { target: { value: answer.question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask of the selected transcripts' }));
}

beforeEach(async () => {
  vi.clearAllMocks(); sessionStorage.clear(); dataset.manifest.sources[0].contentHash = await immutableSourceContentHash(interview); api.describeStudyDataset.mockResolvedValue(dataset); api.listStudyExplorationsPage.mockResolvedValue({ answers: [], nextCursor: null }); api.askStudyQuestion.mockResolvedValue({ answer }); storage.getInterview.mockResolvedValue(interview);
});

afterEach(() => vi.restoreAllMocks());

describe('transcript-backed study exploration', () => {
  it('accepts a failed-analysis transcript and locates quotations only by reading the owned source', async () => {
    renderExplore(); await applyAndAsk();
    await screen.findByText('Offline access is an overlooked concern.');
    expect(api.askStudyQuestion).toHaveBeenCalledWith(study.id, { question: answer.question, selection: {} }, expect.any(String));
    await waitFor(() => expect(storage.getInterview).toHaveBeenCalledWith(interview.id, study.id));
    const citation = await screen.findByRole('button', { name: /t\.2/ }); fireEvent.click(citation);
    expect(screen.getByText('Quotation located; this does not verify the interpretation.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read in full transcript' })).toHaveAttribute('href', `/dashboard/interview/${interview.id}?studyId=${study.id}&turn=2`);
    expect(screen.getByText(/1 selected transcripts lacked complete individual analysis/)).toBeInTheDocument();
  });

  it('refreshes durable answers without asking a provider and refuses a wrong-speaker citation', async () => {
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [answer], nextCursor: null });
    storage.getInterview.mockResolvedValue({ ...interview, transcript: [{ ...interview.transcript[0] }, { ...interview.transcript[1], role: 'ai' }] });
    renderExplore(); await screen.findByText('Offline access is an overlooked concern.');
    await screen.findByText('Quotation not located in the selected participant record.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved answers' }));
    await waitFor(() => expect(api.listStudyExplorationsPage).toHaveBeenCalledTimes(2));
    expect(api.askStudyQuestion).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /t\.2/ })).not.toBeInTheDocument();
  });

  it('does not locate a historical quote against a same-ID replacement whose content hash changed', async () => {
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [answer], nextCursor: null });
    storage.getInterview.mockResolvedValue({ ...interview, transcript: [{ ...interview.transcript[0], content: 'Assume a different context for the same words.' }, interview.transcript[1]] });
    renderExplore();
    await screen.findByText('The original selected source has changed since this answer. A matching quotation in its replacement is not historical evidence.');
    expect(screen.queryByRole('button', { name: /t\.2/ })).not.toBeInTheDocument();
    expect(api.askStudyQuestion).not.toHaveBeenCalled();
  });

  it.each(['budget-limited', 'budget-unavailable'])('explains %s as a pre-provider refusal', async failureKind => {
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [{ ...answer, status: 'failed', result: undefined, execution: undefined, failureKind }], nextCursor: null });
    renderExplore();
    await screen.findByText(/no provider request was made/i);
    expect(screen.getByText(/^Execution not yet recorded/)).toBeInTheDocument();
    expect(api.askStudyQuestion).not.toHaveBeenCalled();
  });

  it('shows requested and served models separately and does not call a Vercel route direct', async () => {
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [{ ...answer, execution: { provider: 'gemini', requestedModel: 'gemini-latest', model: 'gemini-served-snapshot', routedProvider: 'google' } }], nextCursor: null });
    renderExplore();
    const provenance = await screen.findByText(/^Provider gemini · Served model gemini-served-snapshot/);
    expect(provenance).toHaveTextContent('Requested model gemini-latest');
    expect(provenance).toHaveTextContent('Routed provider google · Vercel AI Gateway');
    expect(provenance).not.toHaveTextContent('Direct provider transport');
  });

  it('replays the exact unknown attempt key and payload rather than starting another paid request', async () => {
    api.askStudyQuestion.mockRejectedValueOnce(new ExplorationApiError('Network confirmation lost.', 0)).mockResolvedValueOnce({ answer });
    renderExplore(); await applyAndAsk();
    await screen.findByText('Network confirmation lost.');
    expect(screen.getByRole('textbox', { name: 'Question for these interviews' })).toBeDisabled();
    const first = api.askStudyQuestion.mock.calls[0];
    fireEvent.click(screen.getByRole('button', { name: 'Check this attempt' }));
    await screen.findByText('Offline access is an overlooked concern.');
    expect(api.askStudyQuestion.mock.calls[1]).toEqual(first);
  });

  it('keeps an unsaved generated answer across notebook refresh and retries only saving', async () => {
    api.askStudyQuestion.mockResolvedValue({ answer, unsaved: true, saveReceipt: 'save-only-receipt' });
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [], nextCursor: null });
    renderExplore(); await applyAndAsk();
    await screen.findByText('Offline access is an overlooked concern.');
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [{ ...answer, status: 'running', result: undefined, execution: undefined }], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved answers' }));
    await waitFor(() => expect(api.listStudyExplorationsPage).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Offline access is an overlooked concern.')).toBeInTheDocument();
    api.saveStudyExploration.mockResolvedValue(answer);
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving this answer' }));
    await waitFor(() => expect(api.saveStudyExploration).toHaveBeenCalledWith(study.id, answer.id, 'save-only-receipt'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving this answer' })).not.toBeInTheDocument());
    expect(api.askStudyQuestion).toHaveBeenCalledTimes(1);
  });

  it('allows narrowing after a definitive oversize refusal and never fabricates an answer', async () => {
    api.askStudyQuestion.mockRejectedValue(new ExplorationApiError('Select fewer interviews.', 413, 'EXPLORATION_CORPUS_TOO_LARGE'));
    renderExplore(); await applyAndAsk();
    await screen.findByText('Select fewer interviews.');
    expect(screen.getByRole('textbox', { name: 'Question for these interviews' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Check this attempt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Offline access is an overlooked concern.')).not.toBeInTheDocument();
  });

  it('restores a bounded unsaved answer and its save-only receipt after a page remount', async () => {
    api.askStudyQuestion.mockResolvedValue({ answer, unsaved: true, saveReceipt: 'save-only-receipt' });
    const first = renderExplore(); await applyAndAsk();
    await screen.findByRole('button', { name: 'Retry saving this answer' });
    expect(sessionStorage.getItem(`oi:study-exploration-unsaved:v1:${study.id}`)).toContain('save-only-receipt');
    first.unmount();
    api.listStudyExplorationsPage.mockResolvedValue({ answers: [{ ...answer, status: 'running', result: undefined, execution: undefined }], nextCursor: null });
    renderExplore();
    await screen.findByText('Offline access is an overlooked concern.');
    api.saveStudyExploration.mockResolvedValue(answer);
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving this answer' }));
    await waitFor(() => expect(api.saveStudyExploration).toHaveBeenCalledWith(study.id, answer.id, 'save-only-receipt'));
    await waitFor(() => expect(sessionStorage.getItem(`oi:study-exploration-unsaved:v1:${study.id}`)).toBeNull());
    expect(api.askStudyQuestion).toHaveBeenCalledTimes(1);
  });

  it('keeps memory and local export available if browser recovery storage fails', async () => {
    api.askStudyQuestion.mockResolvedValue({ answer, unsaved: true, saveReceipt: 'save-only-receipt' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    renderExplore(); await applyAndAsk();
    await screen.findByText(/The browser recovery copy could not be stored or read/);
    expect(screen.getByText('Offline access is an overlooked concern.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download answer' })).toBeEnabled();
  });

  it('loads older notebook pages without another provider request and resets to the latest on refresh', async () => {
    const older = { ...answer, id: 'older-answer', question: 'An older question?', createdAt: 50, updatedAt: 51 };
    api.listStudyExplorationsPage.mockResolvedValueOnce({ answers: [answer], nextCursor: '1000:answer-one' }).mockResolvedValueOnce({ answers: [older], nextCursor: null }).mockResolvedValueOnce({ answers: [answer], nextCursor: '1000:answer-one' });
    renderExplore(); await screen.findByRole('button', { name: 'Load older saved answers' });
    fireEvent.click(screen.getByRole('button', { name: 'Load older saved answers' }));
    await screen.findByRole('heading', { name: 'An older question?' });
    expect(api.listStudyExplorationsPage).toHaveBeenLastCalledWith(study.id, '1000:answer-one');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved answers' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'An older question?' })).not.toBeInTheDocument());
    expect(api.listStudyExplorationsPage).toHaveBeenLastCalledWith(study.id, undefined);
    expect(api.askStudyQuestion).not.toHaveBeenCalled();
  });

  it('sends an explicit revision and inclusive numeric filter, with honest unknown counts', async () => {
    renderExplore(); await screen.findByRole('button', { name: 'Apply dataset selection' });
    fireEvent.click(screen.getByRole('checkbox', { name: /All retained revisions/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Revision 1/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Recorded field' }), { target: { value: 'age' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Match' }), { target: { value: 'number-between' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum' }), { target: { value: '20' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum' }), { target: { value: '39' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add profile filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply dataset selection' }));
    await waitFor(() => expect(api.describeStudyDataset).toHaveBeenLastCalledWith(study.id, { revisions: [1], filters: [{ fieldId: 'age', operator: 'number-between', minimum: 20, maximum: 39 }] }));
    expect(within(screen.getByRole('region', { name: 'Research dataset' })).getByText(/1 unknown for the profile filters/)).toBeInTheDocument();
  });
});
