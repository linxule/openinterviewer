import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';

export const PARTICIPANT_CONSENT_TTL_SECONDS = 4 * 60 * 60;

export interface ParticipantConsentRecord {
  version: 1;
  participantSessionId: string;
  studyId: string;
  studyRevision: number;
  consentHash: string;
  acceptedAt: number;
}

export type RecordParticipantConsentResult =
  | { status: 'accepted'; consent: ParticipantConsentRecord }
  | { status: 'conflict' }
  | { status: 'unavailable' };

export type VerifyParticipantConsentResult =
  | { status: 'accepted'; consent: ParticipantConsentRecord }
  | { status: 'missing' }
  | { status: 'mismatch' }
  | { status: 'unavailable' };

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const STUDY_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const CONSENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

const RECORD_CONSENT_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return ARGV[1]
`;

function consentKey(participantSessionId: string): string {
  const digest = createHash('sha256').update(participantSessionId).digest('hex');
  return `participant-consent:${digest}`;
}

export function hashConsentText(consentText: string): string {
  return createHash('sha256').update(consentText).digest('hex');
}

function parseConsentRecord(value: unknown): ParticipantConsentRecord | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Partial<ParticipantConsentRecord>;
  if (
    record.version !== 1
    || typeof record.participantSessionId !== 'string'
    || !SESSION_ID_PATTERN.test(record.participantSessionId)
    || typeof record.studyId !== 'string'
    || !STUDY_ID_PATTERN.test(record.studyId)
    || typeof record.studyRevision !== 'number'
    || !Number.isSafeInteger(record.studyRevision)
    || record.studyRevision < 1
    || typeof record.consentHash !== 'string'
    || !CONSENT_HASH_PATTERN.test(record.consentHash)
    || typeof record.acceptedAt !== 'number'
    || !Number.isSafeInteger(record.acceptedAt)
    || record.acceptedAt <= 0
  ) {
    return null;
  }

  return record as ParticipantConsentRecord;
}

function expectedBinding(options: {
  participantSessionId: string;
  studyId: string;
  studyRevision: number;
  consentText: string;
}) {
  return {
    participantSessionId: options.participantSessionId,
    studyId: options.studyId,
    studyRevision: options.studyRevision,
    consentHash: hashConsentText(options.consentText),
  };
}

function matchesBinding(
  record: ParticipantConsentRecord,
  expected: ReturnType<typeof expectedBinding>
): boolean {
  return record.participantSessionId === expected.participantSessionId
    && record.studyId === expected.studyId
    && record.studyRevision === expected.studyRevision
    && record.consentHash === expected.consentHash;
}

export async function recordParticipantConsent(
  options: {
    participantSessionId: string;
    studyId: string;
    studyRevision: number;
    consentText: string;
  },
  client: Redis
): Promise<RecordParticipantConsentResult> {
  const expected = expectedBinding(options);
  if (
    !SESSION_ID_PATTERN.test(expected.participantSessionId)
    || !STUDY_ID_PATTERN.test(expected.studyId)
    || !Number.isSafeInteger(expected.studyRevision)
    || expected.studyRevision < 1
  ) {
    return { status: 'conflict' };
  }

  const consent: ParticipantConsentRecord = {
    version: 1,
    ...expected,
    acceptedAt: Date.now(),
  };

  try {
    const stored = parseConsentRecord(
      await client.eval<string[], unknown>(
        RECORD_CONSENT_SCRIPT,
        [consentKey(expected.participantSessionId)],
        [JSON.stringify(consent), String(PARTICIPANT_CONSENT_TTL_SECONDS)]
      )
    );
    if (!stored || !matchesBinding(stored, expected)) return { status: 'conflict' };
    return { status: 'accepted', consent: stored };
  } catch (error) {
    console.error('Participant consent storage unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}

export async function verifyParticipantConsent(
  options: {
    participantSessionId: string;
    studyId: string;
    studyRevision: number;
    consentText: string;
  },
  client: Redis
): Promise<VerifyParticipantConsentResult> {
  const expected = expectedBinding(options);
  if (
    !SESSION_ID_PATTERN.test(expected.participantSessionId)
    || !STUDY_ID_PATTERN.test(expected.studyId)
    || !Number.isSafeInteger(expected.studyRevision)
    || expected.studyRevision < 1
  ) {
    return { status: 'mismatch' };
  }

  try {
    const stored = parseConsentRecord(
      await client.get<unknown>(consentKey(expected.participantSessionId))
    );
    if (!stored) return { status: 'missing' };
    if (!matchesBinding(stored, expected)) return { status: 'mismatch' };
    return { status: 'accepted', consent: stored };
  } catch (error) {
    console.error('Participant consent lookup unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return { status: 'unavailable' };
  }
}
