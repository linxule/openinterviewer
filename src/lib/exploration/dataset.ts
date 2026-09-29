import type { ProfileField, StoredInterview } from '@/types';
import type { WorkspaceStorePort } from '@/lib/storage/types';
import { isAwaitingAnalysis } from '@/lib/analysisState';
import {
  MAX_EXPLORATION_CORPUS_BYTES,
  MAX_EXPLORATION_SELECTED_INTERVIEWS,
  type DatasetDescription,
  type DatasetSelection,
  type RecordedProfileFilter,
} from './types';
import { isDatasetSelection, isExplorationId, MAX_DATASET_RETAINED_INTERVIEWS, serializedBytes } from './validation';
import { explorationCorpus } from './corpus';

export type DatasetBuildResult =
  | { status: 'ok'; description: DatasetDescription; interviews: StoredInterview[] }
  | { status: 'invalid-selection'; reason: 'shape' | 'unknown-interview' }
  | { status: 'too-large'; count: number; maximum: number }
  | { status: 'unavailable' };

/** Stable JSON for hashes: property insertion order and selection order do not change scope identity. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new Error('invalid immutable dataset input');
}

export async function datasetDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Analysis retries, summaries and execution timestamps do not alter source identity. */
export async function immutableSourceContentHash(interview: StoredInterview): Promise<string> {
  return datasetDigest({
    interviewId: interview.id,
    studyId: interview.studyId,
    studyRevision: interview.studyRevision ?? null,
    transcript: interview.transcript,
    participantProfile: interview.participantProfile,
    collectionConfig: interview.collectionConfig ?? null,
  });
}

export function normalizeDatasetSelection(selection: DatasetSelection): DatasetSelection {
  return {
    ...(selection.interviewIds !== undefined ? { interviewIds: [...selection.interviewIds].sort() } : {}),
    ...(selection.revisions !== undefined ? { revisions: [...selection.revisions].sort((a, b) => a - b) } : {}),
    ...(selection.filters !== undefined ? { filters: selection.filters.map(filter =>
      filter.operator === 'one-of' ? { ...filter, values: [...filter.values].sort() } : { ...filter }
    ).sort((a, b) => a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0) } : {}),
  };
}

function fieldDefinition(interview: StoredInterview, fieldId: string): ProfileField | undefined {
  // A present value is not a historical definition. Legacy records remain unknown.
  return Array.isArray(interview.collectionConfig?.profileSchema)
    ? interview.collectionConfig.profileSchema.find(field => field.id === fieldId) : undefined;
}

function exactString(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

/** Only one scalar number, never units, age bands, ranges or a demographic guess. */
function scalarNumber(value: string): number | null {
  const scalar = value.trim();
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(scalar)) return null;
  const parsed = Number(scalar);
  return Number.isFinite(parsed) ? parsed : null;
}

export type ProfileFilterMatch = 'match' | 'excluded' | 'unknown';

export function matchRecordedProfileFilter(
  interview: StoredInterview,
  filter: RecordedProfileFilter,
): ProfileFilterMatch {
  if (!fieldDefinition(interview, filter.fieldId)) return 'unknown';
  const fields = interview.participantProfile.fields.filter(field => field.fieldId === filter.fieldId);
  if (fields.length !== 1) return 'unknown';
  const field = fields[0];
  if (field.status !== 'extracted' || typeof field.value !== 'string' || !field.value.trim()) return 'unknown';
  if (filter.operator === 'number-between') {
    const value = scalarNumber(field.value);
    return value === null ? 'unknown' : value >= filter.minimum && value <= filter.maximum ? 'match' : 'excluded';
  }
  const value = exactString(field.value);
  const matches = filter.operator === 'equals'
    ? value === exactString(filter.value)
    : filter.values.some(candidate => value === exactString(candidate));
  return matches ? 'match' : 'excluded';
}

function validSource(interview: StoredInterview, studyId: string): boolean {
  return interview !== null && typeof interview === 'object'
    && interview.studyId === studyId && isExplorationId(interview.id) && interview.status === 'completed'
    && Array.isArray(interview.transcript) && interview.transcript.every(turn =>
      turn && typeof turn.content === 'string' && ['user', 'ai', 'system'].includes(turn.role)
      && typeof turn.id === 'string' && typeof turn.timestamp === 'number'
      && Number.isFinite(turn.timestamp) && turn.timestamp >= 0)
    && interview.participantProfile !== null && typeof interview.participantProfile === 'object'
    && Array.isArray(interview.participantProfile.fields)
    && interview.participantProfile.fields.every(field => field && typeof field.fieldId === 'string'
      && (field.value === null || typeof field.value === 'string')
      && ['pending', 'extracted', 'vague', 'refused'].includes(field.status))
    && (interview.studyRevision === undefined || (Number.isSafeInteger(interview.studyRevision) && interview.studyRevision >= 1))
    && (interview.collectionConfig === undefined || (interview.collectionConfig !== null
      && typeof interview.collectionConfig === 'object' && interview.collectionConfig.id === studyId
      && Array.isArray(interview.collectionConfig.profileSchema)
      && interview.collectionConfig.profileSchema.every(field => field && isExplorationId(field.id)
        && typeof field.label === 'string' && typeof field.extractionHint === 'string'
        && typeof field.required === 'boolean'
        && (field.options === undefined || (Array.isArray(field.options) && field.options.every(option => typeof option === 'string'))))));
}

/**
 * Pure construction after a study-scoped read. A failed/oversized read must
 * never become a smaller successful dataset. Count descriptions precede the
 * provider corpus cap, so researchers can inspect and narrow a large selection.
 */
export async function buildDatasetDescription(
  studyId: string,
  interviews: StoredInterview[],
  selection: DatasetSelection = {},
): Promise<DatasetBuildResult> {
  if (!isExplorationId(studyId) || !isDatasetSelection(selection)) return { status: 'invalid-selection', reason: 'shape' };
  if (interviews.length > MAX_DATASET_RETAINED_INTERVIEWS) {
    return { status: 'too-large', count: interviews.length, maximum: MAX_DATASET_RETAINED_INTERVIEWS };
  }
  if (!interviews.every(interview => validSource(interview, studyId))
    || new Set(interviews.map(interview => interview.id)).size !== interviews.length) return { status: 'unavailable' };
  const retainedIds = new Set(interviews.map(interview => interview.id));
  if (selection.interviewIds?.some(id => !retainedIds.has(id))) return { status: 'invalid-selection', reason: 'unknown-interview' };
  const normalized = normalizeDatasetSelection(selection);
  const requestedIds = normalized.interviewIds !== undefined ? new Set(normalized.interviewIds) : null;
  const requestedRevisions = normalized.revisions !== undefined ? new Set(normalized.revisions) : null;
  const candidates = interviews.filter(interview => (!requestedIds || requestedIds.has(interview.id))
    && (!requestedRevisions || (interview.studyRevision !== undefined && requestedRevisions.has(interview.studyRevision))));
  const definitions = new Map<string, ProfileField>();
  const ambiguousDefinitions = new Set<string>();
  for (const interview of candidates) {
    for (const field of interview.collectionConfig?.profileSchema ?? []) {
      const previous = definitions.get(field.id);
      if (previous && canonicalJson(previous) !== canonicalJson(field)) ambiguousDefinitions.add(field.id);
      else definitions.set(field.id, field);
    }
  }
  let unknownProfileCount = 0;
  const selected = candidates.filter(interview => {
    const matches = (normalized.filters ?? []).map(filter => ambiguousDefinitions.has(filter.fieldId)
      ? 'unknown' : matchRecordedProfileFilter(interview, filter));
    // A known non-match decides exclusion; uncertainty is counted only when it
    // actually prevented deciding whether this record belongs to the cohort.
    if (matches.includes('excluded')) return false;
    if (matches.includes('unknown')) { unknownProfileCount += 1; return false; }
    return true;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  try {
    const sources = await Promise.all(selected.map(async interview => ({
      interviewId: interview.id,
      studyRevision: interview.studyRevision ?? null,
      contentHash: await immutableSourceContentHash(interview),
    })));
    const revisions = new Map<number | null, { revision: number | null; count: number; analyzedCount: number }>();
    for (const interview of interviews) {
      const revision = interview.studyRevision ?? null;
      const row = revisions.get(revision) ?? { revision, count: 0, analyzedCount: 0 };
      row.count += 1;
      if (!isAwaitingAnalysis(interview)) row.analyzedCount += 1;
      revisions.set(revision, row);
    }
    return { status: 'ok', interviews: selected, description: {
      manifest: {
        studyId, selection: normalized, sources,
        totalSaved: interviews.length, selectedCount: selected.length,
        excludedCount: interviews.length - selected.length, unknownProfileCount,
        pendingAnalysisCount: selected.filter(isAwaitingAnalysis).length,
        sourceFingerprint: await datasetDigest({ studyId, selection: normalized, sources }),
      },
      revisions: [...revisions.values()].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)),
      profileFields: [...definitions.values()].filter(field => !ambiguousDefinitions.has(field.id))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(field => structuredClone(field)),
      historicalProfileUnknownCount: interviews.filter(interview => interview.collectionConfig === undefined).length,
      ambiguousProfileFieldIds: [...ambiguousDefinitions].sort(),
    } };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function loadStudyDataset(input: {
  studyId: string;
  selection?: DatasetSelection;
  store: Pick<WorkspaceStorePort, 'listInterviews'>;
}): Promise<DatasetBuildResult> {
  if (!isExplorationId(input.studyId) || !isDatasetSelection(input.selection ?? {})) return { status: 'invalid-selection', reason: 'shape' };
  try {
    // Durable store implements bounded keyset pagination behind this port.
    const loaded = await input.store.listInterviews({ scope: 'study', studyId: input.studyId, maximum: MAX_DATASET_RETAINED_INTERVIEWS });
    if (loaded.status !== 'ok') return loaded;
    return buildDatasetDescription(input.studyId, loaded.items, input.selection);
  } catch {
    return { status: 'unavailable' };
  }
}

/** Counts the exact serialized provider records, including expanded unknown profile labels. */
export function explorationCorpusBytes(interviews: StoredInterview[]): number {
  return serializedBytes(explorationCorpus(interviews));
}

export function assertExplorationCorpus(interviews: StoredInterview[]):
  | { status: 'ok'; bytes: number }
  | { status: 'empty' }
  | { status: 'too-large'; reason: 'interviews' | 'bytes'; maximum: number; actual: number } {
  if (interviews.length === 0) return { status: 'empty' };
  if (interviews.length > MAX_EXPLORATION_SELECTED_INTERVIEWS) return {
    status: 'too-large', reason: 'interviews', maximum: MAX_EXPLORATION_SELECTED_INTERVIEWS, actual: interviews.length,
  };
  const bytes = explorationCorpusBytes(interviews);
  return bytes > MAX_EXPLORATION_CORPUS_BYTES
    ? { status: 'too-large', reason: 'bytes', maximum: MAX_EXPLORATION_CORPUS_BYTES, actual: bytes }
    : { status: 'ok', bytes };
}
