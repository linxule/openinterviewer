// The smoke runner's failure boundary. Anything thrown by an adapter may carry
// the SDK's response on `cause` or as attached properties, and a validation
// failure's message may quote model output. Vitest prints thrown errors in
// full, so the runner must never rethrow the original. This module reduces a
// failure to an allowlisted class and kind, and mints a fresh Error with no
// cause, no extra properties, and a message built only from those two fields.

import { ProviderFailure, ProviderTimeoutError } from '@/lib/providerErrors';

export type SmokeFailure =
  | { class: 'ProviderFailure'; kind: ProviderFailure['kind'] }
  | { class: 'ProviderTimeoutError' }
  | { class: 'ValidationError' | 'UnknownError' };

const KINDS = new Set<ProviderFailure['kind']>(['unavailable', 'rate-limited', 'config', 'invalid-response']);

/** Classify without reading message, cause, or any attached property. */
export function classifySmokeFailure(error: unknown): SmokeFailure {
  if (error instanceof ProviderFailure) {
    return { class: 'ProviderFailure', kind: KINDS.has(error.kind) ? error.kind : 'unavailable' };
  }
  if (error instanceof ProviderTimeoutError) return { class: 'ProviderTimeoutError' };
  if (error instanceof Error && error.name === 'ValidationError') return { class: 'ValidationError' };
  return { class: 'UnknownError' };
}

/** A fresh error whose every observable surface is derived from the class and kind alone. */
export function sanitizedSmokeError(failure: SmokeFailure): Error {
  const label = failure.class === 'ProviderFailure' ? `${failure.class}/${failure.kind}` : failure.class;
  const error = new Error(`live provider smoke failed: ${label}`);
  error.name = 'SmokeFailure';
  return error;
}
