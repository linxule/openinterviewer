// Storage Service - Client-side interface for interview storage
// Calls API routes which interact with Upstash Redis

import { AggregateSynthesisResult, isPendingStudyStub, PendingStudyStub, StoredInterview, StoredStudy, StudyConfig, StudyWorkspaceItem } from '@/types';
import { logRequestEvent, logRequestFailure } from '@/lib/requestLog';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';
export { isPendingStudyStub };
export type { StudyWorkspaceItem };

export type ResearcherStorageOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'pending'; error: string }
  | { status: 'unavailable'; error: string; retryable: true }
  | { status: 'unauthorized'; error: string }
  | { status: 'not-found'; error: string }
  | { status: 'too-large'; error: string }
  | { status: 'error'; error: string };

export class ResearcherStorageUnavailableError extends Error {
  readonly status = 503;
  readonly retryable = true as const;

  constructor(message = 'Storage is temporarily unavailable.') {
    super(message);
    this.name = 'ResearcherStorageUnavailableError';
  }
}
import {
  classifyStudyMutation,
  type StudyMutationClassification,
} from '@/lib/studyMutationClassification';
import { UUID_V4 } from '@/lib/uuid';

export type StudyDeleteResult = {
  success: boolean;
  pending?: boolean;
  operationId?: string;
  error?: string;
};

export type StudyReconciliationResult = {
  success: boolean;
  completed: number;
  rolledBack: number;
  stillPending: number;
  error?: string;
};

export type SaveStudyResult = {
  status: number;
  classification: StudyMutationClassification;
};

export type SaveStudyOptions = {
  config: StudyConfig;
  /** When set, this is an edit PUT and must not send Idempotency-Key. */
  updateStudyId?: string;
  confirmed?: boolean;
  /** Required for create POST. Must be a UUID v4 owned by one create intent. */
  idempotencyKey?: string;
};

function createConfigPayload(config: StudyConfig): Record<string, unknown> {
  const { id: _id, createdAt: _createdAt, ...rest } = config;
  return rest;
}

// Create POST forwards Idempotency-Key. Edit PUT never sends one. 202 is
// pending-create (typed via classifyStudyMutation).
export async function saveStudy(options: SaveStudyOptions): Promise<SaveStudyResult> {
  const isUpdate = Boolean(options.updateStudyId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!isUpdate) {
    const key = options.idempotencyKey;
    if (key && UUID_V4.test(key)) {
      headers['Idempotency-Key'] = key;
    }
  }

  const response = await fetch(
    isUpdate ? `/api/studies/${options.updateStudyId}` : '/api/studies',
    {
      method: isUpdate ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(
        isUpdate
          ? { config: options.config, ...(options.confirmed ? { confirmed: true } : {}) }
          : { config: createConfigPayload(options.config) }
      ),
    }
  );
  const rawBody = await response.json().catch(() => null);
  return {
    status: response.status,
    classification: classifyStudyMutation(response.status, rawBody),
  };
}

// Save completed interview
export async function saveCompletedInterview(
  interview: Omit<StoredInterview, 'completedAt' | 'status' | 'participantProfile'> & {
    participantProfile: StoredInterview['participantProfile'] | null;
  },
  researcherPreview = false,
  participantSessionHandle?: string | null
): Promise<{ success: boolean; id: string; preview?: boolean }> {
  try {
    const response = await fetch('/api/interviews/save', {
      method: 'POST',
      headers: buildParticipantOrPreviewHeaders({
        researcherPreview,
        participantSessionHandle,
      }),
      body: JSON.stringify({
        ...interview,
        completedAt: Date.now(),
        status: 'completed'
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    return { success: false, id: '' };
  }
}

// Get all interviews (researcher only)
export async function getAllInterviews(): Promise<StoredInterview[]> {
  const outcome = await readAllInterviews();
  if (outcome.status === 'ok') return outcome.value.interviews;
  if (outcome.status === 'pending') throw new StudyOperationPendingError(outcome.error);
  if (outcome.status === 'unavailable') throw new ResearcherStorageUnavailableError(outcome.error);
  logRequestEvent({ event: 'route.failure', errorType: 'UnknownError' });
  return [];
}

export async function readAllInterviews(): Promise<ResearcherStorageOutcome<{
  interviews: StoredInterview[];
  pendingStudies: PendingStudyStub[];
}>> {
  try {
    const response = await fetch('/api/interviews');
    const data = await response.json().catch(() => ({})) as {
      interviews?: StoredInterview[];
      pendingStudies?: PendingStudyStub[];
      code?: string;
      error?: string;
    };
    if (!response.ok) return classifyResearcherStorageFailure(response, data);
    return {
      status: 'ok',
      value: {
        interviews: data.interviews || [],
        pendingStudies: data.pendingStudies || [],
      },
    };
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    return { status: 'unavailable', error: 'Interview storage is temporarily unavailable.', retryable: true };
  }
}

// Get single interview by ID. Hosted detail requires the owning studyId so
// authority can run before any BYOS interview GET.
export async function getInterview(id: string, studyId?: string): Promise<StoredInterview | null> {
  try {
    const query = studyId ? `?studyId=${encodeURIComponent(studyId)}` : '';
    const response = await fetch(`/api/interviews/${encodeURIComponent(id)}${query}`);
    const data = await response.json().catch(() => ({})) as {
      interview?: StoredInterview;
      code?: string;
      error?: string;
    };
    throwIfTypedStorageFailure(response, data);

    if (!response.ok) {
      return null;
    }

    return data.interview || null;
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return null;
  }
}

export async function exportAllInterviews(): Promise<Blob | null> {
  const outcome = await exportAllInterviewsChecked();
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'pending') throw new StudyOperationPendingError(outcome.error);
  if (outcome.status === 'unavailable') throw new ResearcherStorageUnavailableError(outcome.error);
  logRequestEvent({ event: 'route.failure', errorType: 'UnknownError' });
  return null;
}

export async function exportAllInterviewsChecked(): Promise<ResearcherStorageOutcome<Blob>> {
  try {
    const response = await fetch('/api/interviews/export');
    if (response.ok) {
      return { status: 'ok', value: await response.blob() };
    }
    const data = await response.json().catch(() => ({})) as { code?: string; error?: string };
    return classifyResearcherStorageFailure(response, data);
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return { status: 'unavailable', error: 'Interview export is temporarily unavailable.', retryable: true };
  }
}

export class StudyOperationPendingError extends Error {
  readonly code = 'STUDY_OPERATION_PENDING' as const;
  readonly status = 409;

  constructor(message = 'A study operation is already in progress.') {
    super(message);
    this.name = 'StudyOperationPendingError';
  }
}

function classifyResearcherStorageFailure(
  response: Response,
  data: { code?: string; error?: string },
): Exclude<ResearcherStorageOutcome<never>, { status: 'ok' }> {
  if (response.status === 409 && data.code === 'STUDY_OPERATION_PENDING') {
    return { status: 'pending', error: data.error || 'A study operation is already in progress.' };
  }
  if (response.status === 503) {
    return {
      status: 'unavailable',
      error: data.error || 'Storage is temporarily unavailable.',
      retryable: true,
    };
  }
  if (response.status === 401) {
    return { status: 'unauthorized', error: data.error || 'Unauthorized' };
  }
  if (response.status === 413) {
    return { status: 'too-large', error: data.error || 'This collection is too large to load at once.' };
  }
  if (response.status === 404) {
    return { status: 'not-found', error: data.error || 'Not found' };
  }
  return { status: 'error', error: data.error || `API error: ${response.status}` };
}

function throwIfStudyOperationPending(response: Response, data: { code?: string; error?: string }) {
  if (response.status === 409 && data.code === 'STUDY_OPERATION_PENDING') {
    throw new StudyOperationPendingError(data.error);
  }
}

function throwIfTypedStorageFailure(response: Response, data: { code?: string; error?: string }) {
  throwIfStudyOperationPending(response, data);
  const classified = classifyResearcherStorageFailure(response, data);
  if (classified.status === 'unavailable') {
    throw new ResearcherStorageUnavailableError(classified.error);
  }
}

// Get interviews for a specific study
export async function getStudyInterviews(studyId: string): Promise<StoredInterview[]> {
  try {
    const response = await fetch(`/api/interviews?studyId=${encodeURIComponent(studyId)}`);
    const data = await response.json().catch(() => ({})) as {
      interviews?: StoredInterview[];
      code?: string;
      error?: string;
    };
    throwIfTypedStorageFailure(response, data);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return data.interviews || [];
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return [];
  }
}

// Get all studies (researcher only)
export async function getAllStudies(): Promise<{
  studies: StudyWorkspaceItem[];
  pendingStudies?: PendingStudyStub[];
  warning?: string;
  outcome: ResearcherStorageOutcome<{ studies: StudyWorkspaceItem[]; pendingStudies: PendingStudyStub[] }>;
}> {
  try {
    const response = await fetch('/api/studies');
    const data = await response.json().catch(() => ({})) as {
      studies?: StudyWorkspaceItem[];
      pendingStudies?: PendingStudyStub[];
      warning?: string;
      code?: string;
      error?: string;
    };
    if (!response.ok) {
      const outcome = classifyResearcherStorageFailure(response, data);
      return {
        studies: [],
        pendingStudies: [],
        warning: outcome.error,
        outcome,
      };
    }
    const value = {
      studies: data.studies || [],
      pendingStudies: data.pendingStudies || [],
    };
    return {
      ...value,
      warning: data.warning,
      outcome: { status: 'ok', value },
    };
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    return {
      studies: [],
      warning: 'Study storage is temporarily unavailable.',
      outcome: { status: 'unavailable', error: 'Study storage is temporarily unavailable.', retryable: true },
    };
  }
}

// Get single study by ID
export async function getStudy(id: string): Promise<StoredStudy | null> {
  try {
    const response = await fetch(`/api/studies/${id}`);
    const data = await response.json().catch(() => ({})) as {
      study?: StoredStudy;
      code?: string;
      error?: string;
    };
    throwIfTypedStorageFailure(response, data);

    if (!response.ok) {
      return null;
    }

    return data.study || null;
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return null;
  }
}

// Get the stored aggregate synthesis for a study, or null if none exists yet.
export async function getStudyAggregate(id: string): Promise<AggregateSynthesisResult | null> {
  try {
    const response = await fetch(`/api/studies/${encodeURIComponent(id)}/aggregate`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({})) as {
      aggregate?: AggregateSynthesisResult | null;
      code?: string;
      error?: string;
    };
    throwIfTypedStorageFailure(response, data);
    if (!response.ok) return null;
    return data.aggregate ?? null;
  } catch (error) {
    if (error instanceof StudyOperationPendingError || error instanceof ResearcherStorageUnavailableError) {
      throw error;
    }
    logRequestFailure({ event: 'route.failure' }, error);
    return null;
  }
}

// Delete study
export async function deleteStudy(id: string): Promise<StudyDeleteResult> {
  try {
    const response = await fetch(`/api/studies/${id}`, {
      method: 'DELETE'
    });
    const data = await response.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      reconciliationPending?: boolean;
      operationId?: string;
    };

    if (response.status === 202 || data.reconciliationPending || data.operationId) {
      return {
        success: false,
        pending: true,
        operationId: data.operationId,
        error: data.message || data.error || 'Study deletion is awaiting reconciliation.',
      };
    }

    if (!response.ok) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    return { success: false, error: 'Failed to delete study' };
  }
}

// Repair a bounded batch of hosted study create/delete operations. The API is
// authenticated and rate-limited; callers use this on workspace entry and for
// explicit retries after a surfaced 202/pending response.
export async function reconcileStudyOperations(): Promise<StudyReconciliationResult> {
  try {
    const response = await fetch('/api/studies/reconcile', { method: 'POST' });
    const data = await response.json().catch(() => ({})) as {
      completed?: number;
      rolledBack?: number;
      stillPending?: number;
      error?: string;
    };
    if (!response.ok) {
      return {
        success: false,
        completed: 0,
        rolledBack: 0,
        stillPending: 0,
        error: data.error || 'Study reconciliation is temporarily unavailable.',
      };
    }
    return {
      success: true,
      completed: Number.isSafeInteger(data.completed) ? data.completed! : 0,
      rolledBack: Number.isSafeInteger(data.rolledBack) ? data.rolledBack! : 0,
      stillPending: Number.isSafeInteger(data.stillPending) ? data.stillPending! : 0,
    };
  } catch (error) {
    logRequestFailure({ event: 'route.failure' }, error);
    return {
      success: false,
      completed: 0,
      rolledBack: 0,
      stillPending: 0,
      error: 'Study reconciliation is temporarily unavailable.',
    };
  }
}
