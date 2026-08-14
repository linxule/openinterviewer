import { createHash } from 'crypto';
import * as jose from 'jose';
import { getParticipantSigningSecret } from './auth';

const ISSUER = 'openinterviewer';
const AUDIENCE = 'openinterviewer:synthesis-receipt';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== '_receipt')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export async function createSynthesisReceipt(options: {
  studyId: string;
  studyRevision: number;
  participantSessionId: string;
  transcript: unknown;
  participantProfile: unknown;
  behaviorData: unknown;
  synthesis: unknown;
}): Promise<string> {
  return new jose.SignJWT({
    type: 'synthesis-receipt',
    version: 1,
    studyId: options.studyId,
    studyRevision: options.studyRevision,
    participantSessionId: options.participantSessionId,
    dataDigest: digest({
      transcript: options.transcript,
      participantProfile: options.participantProfile,
      behaviorData: options.behaviorData,
      synthesis: options.synthesis,
    }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(getParticipantSigningSecret());
}

export async function verifySynthesisReceipt(options: {
  receipt: string;
  studyId: string;
  studyRevision: number;
  participantSessionId: string;
  transcript: unknown;
  participantProfile: unknown;
  behaviorData: unknown;
  synthesis: unknown;
}): Promise<boolean> {
  try {
    const { payload } = await jose.jwtVerify(options.receipt, getParticipantSigningSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload.type === 'synthesis-receipt'
      && payload.version === 1
      && payload.studyId === options.studyId
      && payload.studyRevision === options.studyRevision
      && payload.participantSessionId === options.participantSessionId
      && payload.dataDigest === digest({
        transcript: options.transcript,
        participantProfile: options.participantProfile,
        behaviorData: options.behaviorData,
        synthesis: options.synthesis,
      });
  } catch {
    return false;
  }
}
