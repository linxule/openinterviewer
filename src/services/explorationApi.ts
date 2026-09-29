import type { DatasetDescription, DatasetManifest, DatasetSelection, ExplorationAnswer } from '@/lib/exploration/types';

import { isDatasetManifest, isExplorationAnswer } from '@/lib/exploration/validation';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function manifest(value: unknown, studyId: string): value is DatasetManifest {
  return isDatasetManifest(value) && value.studyId === studyId;
}

function answer(value: unknown, studyId: string): value is ExplorationAnswer {
  return isExplorationAnswer(value) && value.studyId === studyId;
}

export class ExplorationApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ExplorationApiError';
  }
}

async function request(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(url, { cache: 'no-store', ...init }); }
  catch { throw new ExplorationApiError('The request could not be confirmed. Check this attempt before starting another paid request.', 0); }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ExplorationApiError(record(data) && typeof data.error === 'string' ? data.error : 'The research data could not be read.', response.status, record(data) && typeof data.code === 'string' ? data.code : undefined);
  }
  if (!record(data)) throw new ExplorationApiError('The server returned an unreadable response. No result was confirmed.', response.status);
  return data;
}

const base = (studyId: string) => `/api/studies/${encodeURIComponent(studyId)}`;

export async function describeStudyDataset(studyId: string, selection?: DatasetSelection): Promise<DatasetDescription> {
  const data = await request(`${base(studyId)}/dataset`, selection === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }) });
  const dataset = data.dataset;
  if (!record(dataset) || !manifest(dataset.manifest, studyId) || !count(dataset.historicalProfileUnknownCount)
    || (dataset.ambiguousProfileFieldIds !== undefined && (!Array.isArray(dataset.ambiguousProfileFieldIds) || !dataset.ambiguousProfileFieldIds.every(id => typeof id === 'string')))
    || !Array.isArray(dataset.revisions) || !dataset.revisions.every(revision => record(revision) && (revision.revision === null || count(revision.revision)) && count(revision.count) && count(revision.analyzedCount))
    || !Array.isArray(dataset.profileFields) || !dataset.profileFields.every(field => record(field) && typeof field.id === 'string' && typeof field.label === 'string' && typeof field.extractionHint === 'string' && typeof field.required === 'boolean')) {
    throw new ExplorationApiError('The dataset description could not be confirmed.', 200);
  }
  return dataset as unknown as DatasetDescription;
}

export async function listStudyExplorationsPage(studyId: string, cursor?: string): Promise<{ answers: ExplorationAnswer[]; nextCursor: string | null }> {
  const data = await request(`${base(studyId)}/exploration${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (!Array.isArray(data.answers) || !data.answers.every(value => answer(value, studyId))) throw new ExplorationApiError('The saved answers could not be confirmed.', 200);
  if (data.nextCursor !== undefined && data.nextCursor !== null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 256 || data.nextCursor.length === 0)) throw new ExplorationApiError('The next saved-answer page could not be confirmed.', 200);
  return { answers: data.answers, nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null };
}

/** Compatibility reader for callers that need only the most recent page. */
export async function listStudyExplorations(studyId: string): Promise<ExplorationAnswer[]> {
  return (await listStudyExplorationsPage(studyId)).answers;
}

export interface ExplorationSubmission { answer: ExplorationAnswer; unsaved?: boolean; saveReceipt?: string }

export async function askStudyQuestion(studyId: string, input: { question: string; selection: DatasetSelection; parentAnswerId?: string }, idempotencyKey: string): Promise<ExplorationSubmission> {
  const data = await request(`${base(studyId)}/exploration`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input) });
  if (!answer(data.answer, studyId) || (data.unsaved !== undefined && typeof data.unsaved !== 'boolean') || (data.saveReceipt !== undefined && typeof data.saveReceipt !== 'string')) throw new ExplorationApiError('This attempt returned an unreadable answer. Check the same attempt before starting another paid request.', 200);
  return data as unknown as ExplorationSubmission;
}

export async function readStudyExploration(studyId: string, answerId: string): Promise<ExplorationAnswer> {
  const data = await request(`${base(studyId)}/exploration/${encodeURIComponent(answerId)}`);
  if (!answer(data.answer, studyId) || data.answer.id !== answerId) throw new ExplorationApiError('The saved answer could not be confirmed.', 200);
  return data.answer;
}

export async function saveStudyExploration(studyId: string, answerId: string, receipt: string): Promise<ExplorationAnswer> {
  const data = await request(`${base(studyId)}/exploration/${encodeURIComponent(answerId)}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt }) });
  if (!answer(data.answer, studyId) || data.answer.id !== answerId || data.answer.status !== 'complete') throw new ExplorationApiError('Saving this answer could not be confirmed. Keep the local export and try saving again.', 200);
  return data.answer;
}
