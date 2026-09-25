// Redis implementation of WorkspaceStorePort (Node target only). Wraps the
// existing kv.ts / participantLinks.ts / participantConsent.ts / rateLimit.ts /
// createIdempotency.ts operations without changing their Lua, wire parsers or
// crash-cut behavior. It never constructs a client: every call uses the one
// passed in.
//
// Documented Redis residuals (the durable store is stricter; shared contract
// scenarios never assert these):
//  - link creation and completion do not re-check link/consent/study at the
//    write boundary; routes keep performing those checks first;
//  - save admission checks (P1) and charges (Finish) in separate scripts;
//  - aggregate save does not refuse a deleted study;
//  - sample seed is a non-atomic sequence of writes;
//  - a refused populated delete leaves its in-flight guard behind;
//  - the standalone create-idempotency index is lifetime-bounded.
//
// A hosted store (researcherId set) refuses study create/delete (cross-database
// sagas) and participant-link operations (platform database behind the hosted
// authority gate, whose denials routes map to 401/403/404/409/503); those stay
// on their existing route paths. Every other operation uses the client passed.

import {
  clearSampleWorkspaceRecords,
  createStudyAtomic,
  deleteStudy,
  getAllInterviewsChecked,
  getAllStudiesChecked,
  getInterviewChecked,
  getStudyAggregateChecked,
  getStudyChecked,
  getStudyInterviewsChecked,
  isKVAvailable,
  persistCompletedInterview,
  replaceStudyConfigAtomic,
  saveInterview,
  saveStudy,
  saveStudyAggregate,
  setStudyLinksEnabled,
  standaloneCreateMarkerId,
  studyKeysExist,
  studyOperationMarkerId,
  type CollectionLoadResult,
} from '../kv';
import {
  beginCreateIdempotencyForHash,
  casCreateIdempotencyStateForHash,
  STANDALONE_SCOPE,
} from '../createIdempotency';
import {
  createParticipantLinkRecord,
  getParticipantLinkByCode,
  getParticipantLinkById,
  listParticipantLinksForStudy,
  revokeParticipantLink,
  type ParticipantLinkLoadResult,
} from '../participantLinks';
import { recordParticipantConsent, verifyParticipantConsent } from '../participantConsent';
import { consumeParticipantRateLimits } from '../rateLimit';
import type { RedisPort } from '../redisPort';
import { toStudyListItem } from '../../types';
import { logRequestFailure } from '../requestLog';
import type {
  AdmissionOutcome,
  ClearSampleOutcome,
  CreateLinkOutcome,
  CreateStudyInput,
  CreateStudyOutcome,
  LinkListOutcome,
  LinkLoadOutcome,
  LinkRevokeOutcome,
  SeedSampleOutcome,
  StudyListEntry,
  StudyListView,
  WorkspaceStorePort,
} from './types';
import { RESEARCHER_AI_KEY_PREFIX } from './types';

export type RedisWorkspaceStoreOptions = {
  /** Hosted researcher id; null in standalone. */
  researcherId: string | null;
};

export type StandaloneOnlyOperation =
  | 'createStudy'
  | 'deleteStudy'
  | 'createParticipantLink'
  | 'resolveParticipantLinkByCode'
  | 'getParticipantLinkById'
  | 'listParticipantLinks'
  | 'revokeParticipantLink';

/**
 * A hosted route reached a standalone-only store operation. Hosted
 * create/delete are cross-database sagas owned by their routes, and hosted
 * link operations return authority denials that the store's link outcomes
 * cannot carry; refusing loudly keeps them off a retryable 503.
 */
export class HostedStudyOperationError extends Error {
  constructor(readonly operation: StandaloneOnlyOperation) {
    super(`${operation} on the Redis workspace store is standalone-only`);
    this.name = 'HostedStudyOperationError';
  }
}

function linkLoadOutcome(result: ParticipantLinkLoadResult): LinkLoadOutcome {
  if (result.status === 'found') return { status: 'found', link: result.link };
  if (result.status === 'not-found' || result.status === 'expired' || result.status === 'revoked') {
    return { status: result.status };
  }
  return { status: 'unavailable' };
}

/**
 * The standalone POST /api/studies composition: begin idempotency (with the
 * caller-minted candidate), ping, atomic create, then the created transition
 * whose result is ignored exactly as the route ignores it. The candidate is
 * used only when no mapping exists; every later step uses the mapping's study,
 * so a replay returns the originally minted identity.
 *
 * `idempotencyKeyDigest` must be `hashCreateIdempotencyKey('standalone', key)`.
 */
async function createStandaloneStudy(client: RedisPort, input: CreateStudyInput): Promise<CreateStudyOutcome> {
  const begun = await beginCreateIdempotencyForHash({
    client,
    mode: 'standalone',
    researcherId: STANDALONE_SCOPE,
    idempotencyHash: input.idempotencyKeyDigest,
    fingerprint: input.fingerprint,
    mintStudy: () => input.candidate,
  });
  if (begun.status === 'reuse') return { status: 'key-reuse' };
  if (begun.status === 'quota') return { status: 'quota' };
  if (begun.status === 'ambiguous') return { status: 'ambiguous' };
  if (begun.status !== 'started' && begun.status !== 'replay') return { status: 'unavailable' };

  const mapping = begun.record;
  const replayed = begun.status === 'replay';
  if (replayed && mapping.state === 'deleted') return { status: 'key-consumed' };
  if (replayed && mapping.state === 'created') {
    return { status: 'created', study: mapping.study, replayed: true };
  }

  if (!(await isKVAvailable(client))) return { status: 'unavailable' };

  const study = mapping.study;
  const marker = standaloneCreateMarkerId(study.id, study.createdAt);
  if (!marker) return { status: 'unavailable' };
  const creation = await createStudyAtomic(study, client, marker, {
    idempotencyHash: input.idempotencyKeyDigest,
    researcherId: STANDALONE_SCOPE,
  });
  if (creation === 'ambiguous') return { status: 'ambiguous' };
  if (creation === 'unavailable') return { status: 'unavailable' };
  if (creation === 'cancelled' || creation === 'conflict') return { status: 'conflict' };

  await casCreateIdempotencyStateForHash({
    client,
    mode: 'standalone',
    researcherId: STANDALONE_SCOPE,
    idempotencyHash: input.idempotencyKeyDigest,
    fingerprint: input.fingerprint,
    nextState: 'created',
    operationId: mapping.operationId,
  });
  return { status: 'created', study, replayed };
}

export function createRedisWorkspaceStore(client: RedisPort, options: RedisWorkspaceStoreOptions): WorkspaceStorePort {
  const researcherId = options.researcherId;
  const standaloneOnly = (operation: StandaloneOnlyOperation) => {
    if (researcherId !== null) throw new HostedStudyOperationError(operation);
  };

  return {
    backend: 'redis',

    async readiness() {
      return (await isKVAvailable(client))
        ? { status: 'ready', maintenance: 'open' }
        : { status: 'unavailable' };
    },

    getStudy: (studyId) => getStudyChecked(studyId, client),
    async listStudies<V extends StudyListView>(maximum: number, { view }: { view: V }) {
      const loaded = await getAllStudiesChecked(client, maximum);
      if (view === 'full' || loaded.status !== 'ok') return loaded as CollectionLoadResult<StudyListEntry<V>>;
      return { status: 'ok', items: loaded.items.map(toStudyListItem) } as CollectionLoadResult<StudyListEntry<V>>;
    },

    async createStudy(input) {
      standaloneOnly('createStudy');
      return createStandaloneStudy(client, input);
    },

    // Config identity must agree with the row identity (02-storage.md), as the
    // durable store enforces; routes always pass the canonical id.
    async replaceStudyConfig(input) {
      if (input.config?.id !== input.studyId) return { status: 'unavailable' };
      return replaceStudyConfigAtomic(input.studyId, input.expectedRevision, input.config, client);
    },
    setStudyLinksEnabled: (input) => setStudyLinksEnabled(input.studyId, input.enabled, client),

    async deleteStudy(input) {
      standaloneOnly('deleteStudy');
      const marker = studyOperationMarkerId(`delete:${input.studyId}`, 0);
      return deleteStudy(input.studyId, client, marker ?? undefined);
    },

    async createParticipantLink(input): Promise<CreateLinkOutcome> {
      standaloneOnly('createParticipantLink');
      const created = await createParticipantLinkRecord({
        studyId: input.studyId,
        studyRevision: input.studyRevision,
        researcherId: null,
        expiresAt: input.expiresAt,
        standaloneClient: client,
      });
      if (created.status === 'created') return { status: 'created', code: created.code, link: created.link };
      if (created.status === 'quota-exceeded') return { status: 'quota-exceeded' };
      if (created.status === 'ambiguous') return { status: 'ambiguous' };
      return { status: 'unavailable' };
    },

    async resolveParticipantLinkByCode(input) {
      standaloneOnly('resolveParticipantLinkByCode');
      return linkLoadOutcome(await getParticipantLinkByCode(input.code, client));
    },

    async getParticipantLinkById(input) {
      standaloneOnly('getParticipantLinkById');
      return linkLoadOutcome(await getParticipantLinkById(input.linkId, client));
    },

    async listParticipantLinks(input): Promise<LinkListOutcome> {
      standaloneOnly('listParticipantLinks');
      const listed = await listParticipantLinksForStudy({
        studyId: input.studyId,
        researcherId: null,
        standaloneClient: client,
        maximum: input.maximum,
      });
      if (listed.status === 'ok') return { status: 'ok', links: listed.links, truncated: listed.truncated };
      return { status: 'unavailable' };
    },

    async revokeParticipantLink(input): Promise<LinkRevokeOutcome> {
      standaloneOnly('revokeParticipantLink');
      const revoked = await revokeParticipantLink({
        linkId: input.linkId,
        studyId: input.studyId,
        researcherId: null,
        standaloneClient: client,
      });
      if (revoked.status === 'revoked') return { status: 'revoked', revokedAt: revoked.revokedAt };
      if (
        revoked.status === 'already-revoked'
        || revoked.status === 'not-found'
        || revoked.status === 'owner-conflict'
        || revoked.status === 'ambiguous'
      ) {
        return { status: revoked.status };
      }
      return { status: 'unavailable' };
    },

    recordConsent: (input) => recordParticipantConsent({
      participantSessionId: input.participantSessionId,
      studyId: input.studyId,
      studyRevision: input.studyRevision,
      consentText: input.consentText,
    }, client),

    verifyConsent: (input) => verifyParticipantConsent({
      participantSessionId: input.participantSessionId,
      studyId: input.studyId,
      studyRevision: input.studyRevision,
      consentText: input.consentText,
    }, client),

    async admitParticipantRequest(input): Promise<AdmissionOutcome> {
      try {
        const decision = await consumeParticipantRateLimits(client, input.counters);
        if (decision.allowed) return { status: 'admitted' };
        return {
          status: 'limited',
          rejectedIndex: decision.rejectedIndex,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      } catch (error) {
        logRequestFailure({ event: 'kv.unavailable', operation: input.operation }, error);
        return { status: 'unavailable' };
      }
    },

    // Same check-all-then-charge script as participant admission, over
    // `researcher-ai:` keys. A hosted store keeps the platform limiter and
    // never charges the researcher's own database.
    async admitResearcherAiRequest(input): Promise<AdmissionOutcome> {
      if (researcherId !== null) return { status: 'unavailable' };
      if (
        input.counters.length === 0
        || !input.counters.every(counter => counter.key.startsWith(RESEARCHER_AI_KEY_PREFIX))
      ) {
        return { status: 'unavailable' };
      }
      try {
        const decision = await consumeParticipantRateLimits(client, input.counters);
        if (decision.allowed) return { status: 'admitted' };
        return {
          status: 'limited',
          rejectedIndex: decision.rejectedIndex,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      } catch (error) {
        logRequestFailure({ event: 'kv.unavailable', operation: `researcher-ai-${input.operation}` }, error);
        return { status: 'unavailable' };
      }
    },

    persistCompletedInterview: (input) => persistCompletedInterview(
      input.interview,
      input.fingerprint,
      {
        allowDisabledLinks: input.allowDisabledLinks,
        expectedStudyRevision: input.expectedStudyRevision,
        rateLimits: input.ratePlan,
        identity: input.identity,
      },
      client
    ),

    getInterview: (interviewId) => getInterviewChecked(interviewId, client),

    listInterviews: (input) => input.scope === 'study'
      ? getStudyInterviewsChecked(input.studyId, client, input.maximum)
      : getAllInterviewsChecked(client, input.maximum),

    getAggregate: (studyId) => getStudyAggregateChecked(studyId, client),
    saveAggregate: (aggregate) => saveStudyAggregate(aggregate, client),

    // The former POST /api/demo/seed write sequence. Partial writes still
    // report `seeded` with the counts that landed, as the route always has.
    async seedSampleWorkspace(input): Promise<SeedSampleOutcome> {
      if (!(await isKVAvailable(client))) return { status: 'unavailable' };
      const collision = await studyKeysExist(input.studies.map(study => study.id), client);
      if (collision === 'unavailable') return { status: 'unavailable' };
      if (collision === 'present') return { status: 'already-seeded' };

      let studiesSeeded = 0;
      for (const study of input.studies) {
        if (await saveStudy(study, client)) studiesSeeded += 1;
      }
      let interviewsSeeded = 0;
      for (const interview of input.interviews) {
        if (await saveInterview(interview, client)) interviewsSeeded += 1;
      }
      return { status: 'seeded', studiesSeeded, interviewsSeeded };
    },

    async clearSampleWorkspace(input): Promise<ClearSampleOutcome> {
      if (!(await isKVAvailable(client))) return { status: 'unavailable' };
      return clearSampleWorkspaceRecords(input, client);
    },
  };
}
