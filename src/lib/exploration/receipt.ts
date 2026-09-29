import * as jose from 'jose';
import { getResearcherArtifactSigningSecret, TOKEN_ISSUER } from '@/lib/auth';
import type { CompleteExplorationInput } from './types';
import { isCompleteExplorationInput } from './validation';

const AUDIENCE = 'openinterviewer:exploration-save';
const MAX_RECEIPT_CHARS = 300_000;
const DURATION_SECONDS = 24 * 60 * 60;

/** Save-only recovery: a signed result cannot authorize another provider call. */
export async function signExplorationReceipt(input: CompleteExplorationInput, researcherId: string | null): Promise<string> {
  if (!isCompleteExplorationInput(input)) throw new Error('Invalid exploration receipt input');
  const receipt = await new jose.SignJWT({ type: 'exploration-save', version: 1, input, researcherId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(TOKEN_ISSUER).setAudience(AUDIENCE)
    .setSubject(input.studyId).setIssuedAt().setExpirationTime(`${DURATION_SECONDS}s`)
    .sign(getResearcherArtifactSigningSecret());
  if (receipt.length > MAX_RECEIPT_CHARS) throw new Error('Exploration receipt exceeds bound');
  return receipt;
}

export async function verifyExplorationReceipt(receipt: unknown, identity: {
  researcherId: string | null; studyId: string; answerId: string;
}): Promise<CompleteExplorationInput | null> {
  if (typeof receipt !== 'string' || receipt.length > MAX_RECEIPT_CHARS) return null;
  try {
    const { payload } = await jose.jwtVerify(receipt, getResearcherArtifactSigningSecret(), {
      algorithms: ['HS256'], issuer: TOKEN_ISSUER, audience: AUDIENCE,
    });
    if (payload.type !== 'exploration-save' || payload.version !== 1 || payload.sub !== identity.studyId
      || payload.researcherId !== identity.researcherId || !isCompleteExplorationInput(payload.input)
      || payload.input.studyId !== identity.studyId || payload.input.answerId !== identity.answerId) return null;
    return payload.input;
  } catch { return null; }
}
