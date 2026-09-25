import type { ProviderCommitment, StoredInterview } from '@/types';

/**
 * What a study's consent notice promises about the AI provider, and the check
 * that keeps it. 'fixed': the notice names the provider and model, and a
 * transcript saved under it goes to that provider and model only. 'may-change':
 * the notice says the researcher may later use another provider or model.
 * Records without a commitment (saved before it existed) are not checked.
 *
 * Only a researcher retry can reach an older transcript with a newer
 * configuration: aggregate and follow-up read only interviews saved under the
 * study's current revision, and every configuration edit advances it.
 */
export const PROVIDER_COMMITMENTS: readonly ProviderCommitment[] = ['fixed', 'may-change'];

/** New studies start with the narrower promise. */
export const DEFAULT_PROVIDER_COMMITMENT: ProviderCommitment = 'fixed';

export function isProviderCommitment(value: unknown): value is ProviderCommitment {
  return value === 'fixed' || value === 'may-change';
}

type CommittedRecord = Pick<StoredInterview, 'providerCommitment' | 'conductedByProvider' | 'conductedByModel'>;

/** Whether a call with this provider and model may carry the record's transcript. */
export function commitmentCovers(record: CommittedRecord, provider: unknown, model: unknown): boolean {
  if (record.providerCommitment !== 'fixed') return true;
  return typeof record.conductedByProvider === 'string'
    && typeof record.conductedByModel === 'string'
    && record.conductedByProvider === provider
    && record.conductedByModel === model;
}
