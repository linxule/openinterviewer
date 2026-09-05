// Classifies researcher study mutation HTTP responses. Create 202 is
// pending-create; idempotency reuse/consumed are ordinary errors.

export const IDEMPOTENCY_KEY_REUSE = 'IDEMPOTENCY_KEY_REUSE';
export const IDEMPOTENCY_KEY_CONSUMED = 'IDEMPOTENCY_KEY_CONSUMED';

export type StudyMutationResponseBody = {
  error?: string;
  message?: string;
  code?: string;
  study?: { id: string; config?: unknown; revision?: number };
  studyId?: string;
  operationId?: string;
  reconciliationPending?: boolean;
  requiresConfirmation?: boolean;
  warning?: string;
  retryable?: boolean;
  reason?: string;
  phase?: string;
  retryAfterSeconds?: number;
};

export type StudyMutationClassification =
  | { outcome: 'pending-create'; body: StudyMutationResponseBody }
  | { outcome: 'success'; body: StudyMutationResponseBody }
  | { outcome: 'error'; status: number; body: StudyMutationResponseBody }
  | { outcome: 'protocol-error'; status: number }
  | { outcome: 'unauthorized'; body: StudyMutationResponseBody }
  | { outcome: 'confirm-required'; warning: string; body: StudyMutationResponseBody };

function asBody(value: unknown): StudyMutationResponseBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as StudyMutationResponseBody;
}

export function classifyStudyMutation(
  status: number,
  rawBody: unknown
): StudyMutationClassification {
  const body = asBody(rawBody);
  if (!body) {
    return { outcome: 'protocol-error', status };
  }

  if (status === 202 || body.reconciliationPending === true) {
    return { outcome: 'pending-create', body };
  }

  if (status === 401) {
    return { outcome: 'unauthorized', body };
  }

  if (
    status === 409
    && (body.code === IDEMPOTENCY_KEY_REUSE || body.code === IDEMPOTENCY_KEY_CONSUMED)
  ) {
    return { outcome: 'error', status, body };
  }

  if (status === 409 && body.requiresConfirmation) {
    return {
      outcome: 'confirm-required',
      warning: typeof body.warning === 'string' ? body.warning : 'This study has existing interviews.',
      body,
    };
  }

  if ((status === 200 || status === 201) && body.study && typeof body.study.id === 'string') {
    return { outcome: 'success', body };
  }

  if (status >= 200 && status < 300) {
    return { outcome: 'protocol-error', status };
  }

  return { outcome: 'error', status, body };
}
