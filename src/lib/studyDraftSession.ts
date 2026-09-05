// Browser-session bookkeeping for a study draft: the storage keys, the UUID
// shape, the authority epoch, and the create-key adoption rule. Lifted whole
// out of StudySetup.tsx (C6) — every function body is byte-identical to the
// original. Not to be confused with src/lib/createIdempotency.ts, which is
// the server's create-idempotency mapping.

import { UUID_V4 } from '@/lib/uuid';

export { UUID_V4 };

const IDEM_STATE_STORAGE = 'oi:create-idempotency-state';
const AUTH_EPOCH_STORAGE = 'oi:create-authority-epoch';

export type PersistedCreateIdempotency = {
  intentKey: string;
  authorityEpoch: number;
  key: string;
};

const canUseSessionStorage = () =>
  typeof window !== 'undefined' && typeof sessionStorage !== 'undefined';

export function readAuthorityEpoch(): number {
  if (!canUseSessionStorage()) return 0;
  const raw = sessionStorage.getItem(AUTH_EPOCH_STORAGE);
  const value = raw == null ? 0 : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function writeAuthorityEpoch(epoch: number) {
  if (!canUseSessionStorage()) return;
  sessionStorage.setItem(AUTH_EPOCH_STORAGE, String(epoch));
}

function readPersistedCreateIdempotency(): PersistedCreateIdempotency | null {
  if (!canUseSessionStorage()) return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(IDEM_STATE_STORAGE) || 'null') as PersistedCreateIdempotency | null;
    if (
      parsed
      && typeof parsed.intentKey === 'string'
      && Number.isSafeInteger(parsed.authorityEpoch)
      && typeof parsed.key === 'string'
      && UUID_V4.test(parsed.key)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function persistCreateIdempotency(state: PersistedCreateIdempotency) {
  if (!canUseSessionStorage()) return;
  sessionStorage.setItem(IDEM_STATE_STORAGE, JSON.stringify(state));
}

export function setupIntentKey(prefill: string | null, studyId: string | null, parentId: string | null): string {
  if (prefill === 'edit' && studyId) return `edit:${studyId}`;
  if (prefill === 'followup') return parentId ? `followup:${parentId}` : 'followup';
  return 'create';
}

export function isCreateIntentKey(intentKey: string): boolean {
  return intentKey === 'create' || intentKey.startsWith('followup');
}

export function adoptCreateIdempotencyKey(intentKey: string, authorityEpoch: number): string {
  const stored = readPersistedCreateIdempotency();
  if (
    stored
    && stored.intentKey === intentKey
    && stored.authorityEpoch === authorityEpoch
    && UUID_V4.test(stored.key)
  ) {
    return stored.key;
  }
  const key = crypto.randomUUID();
  persistCreateIdempotency({ intentKey, authorityEpoch, key });
  return key;
}
