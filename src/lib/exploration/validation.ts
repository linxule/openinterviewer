// Portable closed validators shared by HTTP, Redis and Worker storage. No
// provider/runtime imports: a malformed artifact never authorizes a write.
import type { ProviderExecution } from '@/lib/ai';
import type { EvidenceRef } from '@/types';
import {
  MAX_EXPLORATION_QUESTION_CHARS,
  MAX_EXPLORATION_SELECTED_INTERVIEWS,
  type CompleteExplorationInput,
  type DatasetManifest,
  type DatasetSelection,
  type ExplorationAnswer,
  type ExplorationProviderPayload,
  type ExplorationQuoteClaim,
  type ExplorationReservation,
  type ExplorationResponse,
  type FailExplorationInput,
  type RecordedProfileFilter,
} from './types';

export const MAX_EXPLORATION_RESULT_BYTES = 128 * 1024;
export const MAX_EXPLORATION_ARTIFACT_BYTES = 192 * 1024;
export const MAX_DATASET_RETAINED_INTERVIEWS = 1_000;
export const MAX_DATASET_FILTERS = 20;
const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FAILURE_KIND = /^[a-z][a-z0-9-]{0,99}$/;
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closed(value: RecordValue, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function isExplorationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export function isExplorationDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isExplorationQuestion(value: unknown): value is string {
  return text(value, MAX_EXPLORATION_QUESTION_CHARS);
}

/** UTF-8 bytes, not UTF-16 string length; cyclic/unsupported input fails closed. */
export function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Infinity;
  } catch {
    return Infinity;
  }
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

export function isRecordedProfileFilter(value: unknown): value is RecordedProfileFilter {
  if (!record(value) || !isExplorationId(value.fieldId)) return false;
  if (value.operator === 'equals') {
    return closed(value, ['fieldId', 'operator', 'value']) && text(value.value, 256);
  }
  if (value.operator === 'one-of') {
    return closed(value, ['fieldId', 'operator', 'values'])
      && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 20
      && value.values.every(item => text(item, 256)) && unique(value.values);
  }
  return value.operator === 'number-between'
    && closed(value, ['fieldId', 'operator', 'minimum', 'maximum'])
    && typeof value.minimum === 'number' && Number.isFinite(value.minimum)
    && typeof value.maximum === 'number' && Number.isFinite(value.maximum)
    && value.minimum <= value.maximum;
}

export function isDatasetSelection(value: unknown): value is DatasetSelection {
  if (!record(value) || !closed(value, ['interviewIds', 'revisions', 'filters'])) return false;
  if (value.interviewIds !== undefined && (!Array.isArray(value.interviewIds)
    || value.interviewIds.length > MAX_EXPLORATION_SELECTED_INTERVIEWS
    || !value.interviewIds.every(isExplorationId) || !unique(value.interviewIds))) return false;
  if (value.revisions !== undefined && (!Array.isArray(value.revisions)
    || value.revisions.length > 100 || !value.revisions.every(item => integer(item, 1))
    || !unique(value.revisions))) return false;
  if (value.filters !== undefined && (!Array.isArray(value.filters)
    || value.filters.length > MAX_DATASET_FILTERS || !value.filters.every(isRecordedProfileFilter)
    || !unique(value.filters.map(item => item.fieldId)))) return false;
  return true;
}

/** null signals invalid input; an empty selection intentionally selects all. */
export function parseDatasetSelection(value: unknown): DatasetSelection | null {
  if (!isDatasetSelection(value)) return null;
  return structuredClone(value);
}

export function isDatasetManifest(value: unknown): value is DatasetManifest {
  if (!record(value) || !closed(value, [
    'studyId', 'selection', 'sources', 'totalSaved', 'selectedCount', 'excludedCount',
    'unknownProfileCount', 'pendingAnalysisCount', 'sourceFingerprint',
  ]) || !isExplorationId(value.studyId) || !isDatasetSelection(value.selection)
    || !Array.isArray(value.sources) || value.sources.length > MAX_DATASET_RETAINED_INTERVIEWS
    || !isExplorationDigest(value.sourceFingerprint)) return false;
  if (!value.sources.every(source => record(source)
    && closed(source, ['interviewId', 'studyRevision', 'contentHash'])
    && isExplorationId(source.interviewId)
    && (source.studyRevision === null || integer(source.studyRevision, 1))
    && isExplorationDigest(source.contentHash))) return false;
  if (!unique(value.sources.map(source => source.interviewId))) return false;
  const selection = value.selection;
  if (selection.interviewIds !== undefined
    && value.sources.some(source => !selection.interviewIds?.includes(source.interviewId))) return false;
  if (selection.revisions !== undefined
    && value.sources.some(source => source.studyRevision === null || !selection.revisions?.includes(source.studyRevision))) return false;
  if (!integer(value.totalSaved, 0, MAX_DATASET_RETAINED_INTERVIEWS)
    || !integer(value.selectedCount, 0, value.totalSaved)
    || value.selectedCount !== value.sources.length
    || !integer(value.excludedCount, 0, value.totalSaved)
    || value.excludedCount + value.selectedCount !== value.totalSaved
    || !integer(value.unknownProfileCount, 0, value.excludedCount)
    || !integer(value.pendingAnalysisCount, 0, value.selectedCount)) return false;
  return serializedBytes(value) <= 256 * 1024;
}

export function parseDatasetManifest(value: unknown): DatasetManifest | null {
  return isDatasetManifest(value) ? structuredClone(value) : null;
}

export function isProviderExecution(value: unknown): value is ProviderExecution {
  return record(value) && closed(value, ['provider', 'requestedModel', 'model', 'routedProvider', 'aiTransport'])
    && ['gemini', 'claude', 'openai', 'openrouter'].includes(value.provider as string)
    && text(value.requestedModel, 256) && text(value.model, 256)
    && (value.routedProvider === undefined || text(value.routedProvider, 256))
    && (value.aiTransport === undefined || value.aiTransport === 'cloudflare-gateway');
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  return record(value) && closed(value, ['quote', 'turnIndex', 'interviewId'])
    && text(value.quote, 2_000) && integer(value.turnIndex, 1, 100_000)
    && (value.interviewId === undefined || isExplorationId(value.interviewId));
}

export function isExplorationQuoteClaim(value: unknown): value is ExplorationQuoteClaim {
  return record(value) && closed(value, ['quote', 'turnIndex', 'interviewIndex'])
    && text(value.quote, 2_000) && integer(value.turnIndex, 1, 100_000)
    && integer(value.interviewIndex, 1, MAX_EXPLORATION_SELECTED_INTERVIEWS);
}

function response<Ref>(value: unknown, isRef: (input: unknown) => input is Ref): value is ExplorationResponse<Ref> {
  return record(value) && closed(value, ['answer', 'findings', 'limitations'])
    && text(value.answer, 20_000) && Array.isArray(value.findings) && value.findings.length <= 20
    && value.findings.every(finding => record(finding)
      && closed(finding, ['heading', 'interpretation', 'supporting', 'challenging', 'uncertain'])
      && text(finding.heading, 200) && text(finding.interpretation, 8_000)
      && ['supporting', 'challenging', 'uncertain'].every(kind => Array.isArray(finding[kind])
        && finding[kind].length <= 10 && finding[kind].every(isRef)))
    && Array.isArray(value.limitations) && value.limitations.length <= 20
    && value.limitations.every(item => text(item, 2_000))
    && serializedBytes(value) <= MAX_EXPLORATION_RESULT_BYTES;
}

export function isExplorationResponse(value: unknown): value is ExplorationResponse {
  return response(value, isEvidenceRef);
}

export function isExplorationProviderPayload(value: unknown): value is ExplorationProviderPayload {
  return response(value, isExplorationQuoteClaim);
}

export function isExplorationAnswer(value: unknown): value is ExplorationAnswer {
  if (!record(value) || !closed(value, [
    'id', 'studyId', 'question', 'parentAnswerId', 'scope', 'createdAt', 'updatedAt',
    'status', 'requestFingerprint', 'result', 'execution', 'failureKind', 'promptVersion',
  ]) || !isExplorationId(value.id) || !isExplorationId(value.studyId)
    || !isExplorationQuestion(value.question)
    || (value.parentAnswerId !== undefined && (!isExplorationId(value.parentAnswerId) || value.parentAnswerId === value.id))
    || !isDatasetManifest(value.scope) || value.scope.studyId !== value.studyId
    || value.scope.selectedCount < 1 || value.scope.selectedCount > MAX_EXPLORATION_SELECTED_INTERVIEWS
    || !integer(value.createdAt) || !integer(value.updatedAt, value.createdAt)
    || !isExplorationDigest(value.requestFingerprint) || value.promptVersion !== 1) return false;
  if (value.status === 'complete') {
    if (!isExplorationResponse(value.result) || !isProviderExecution(value.execution) || value.failureKind !== undefined) return false;
    const sourceIds = new Set(value.scope.sources.map(source => source.interviewId));
    if (value.result.findings.some(finding => [...finding.supporting, ...finding.challenging, ...finding.uncertain]
      .some(ref => ref.interviewId !== undefined && !sourceIds.has(ref.interviewId)))) return false;
  } else if (value.status === 'running') {
    if (value.result !== undefined || value.execution !== undefined || value.failureKind !== undefined) return false;
  } else if (value.status === 'failed' || value.status === 'recovery-required') {
    if (value.result !== undefined || value.execution !== undefined || typeof value.failureKind !== 'string'
      || !FAILURE_KIND.test(value.failureKind)) return false;
  } else return false;
  return serializedBytes(value) <= MAX_EXPLORATION_ARTIFACT_BYTES;
}

export function parseExplorationAnswer(value: unknown): ExplorationAnswer | null {
  return isExplorationAnswer(value) ? structuredClone(value) : null;
}

export function isExplorationReservation(value: unknown): value is ExplorationReservation {
  return record(value) && closed(value, ['answer', 'keyDigest', 'expectedStudyRevision'])
    && isExplorationAnswer(value.answer) && value.answer.status === 'running'
    && isExplorationDigest(value.keyDigest) && integer(value.expectedStudyRevision, 1);
}

export function isCompleteExplorationInput(value: unknown): value is CompleteExplorationInput {
  return record(value) && closed(value, ['studyId', 'answerId', 'requestFingerprint', 'result', 'execution', 'now'])
    && isExplorationId(value.studyId) && isExplorationId(value.answerId)
    && isExplorationDigest(value.requestFingerprint) && isExplorationResponse(value.result)
    && isProviderExecution(value.execution) && integer(value.now)
    && serializedBytes(value) <= MAX_EXPLORATION_ARTIFACT_BYTES;
}

export function isFailExplorationInput(value: unknown): value is FailExplorationInput {
  return record(value) && closed(value, ['studyId', 'answerId', 'requestFingerprint', 'status', 'failureKind', 'now'])
    && isExplorationId(value.studyId) && isExplorationId(value.answerId)
    && isExplorationDigest(value.requestFingerprint)
    && (value.status === 'failed' || value.status === 'recovery-required')
    && typeof value.failureKind === 'string' && FAILURE_KIND.test(value.failureKind) && integer(value.now);
}
