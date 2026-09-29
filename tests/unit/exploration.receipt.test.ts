// @vitest-environment node

import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signExplorationReceipt, verifyExplorationReceipt } from '@/lib/exploration/receipt';
import { getResearcherArtifactSigningSecret, TOKEN_ISSUER } from '@/lib/auth';
import type { CompleteExplorationInput } from '@/lib/exploration/types';

const input: CompleteExplorationInput = {
  studyId: 'study-fixture', answerId: 'answer-fixture', requestFingerprint: '1'.repeat(64),
  result: { answer: 'A saved synthetic answer.', findings: [], limitations: ['Fixture only.'] },
  execution: { provider: 'gemini', requestedModel: 'gemini-3.7-flash', model: 'gemini-3.7-flash-001' }, now: 1,
};
const identity = { researcherId: 'researcher-a', studyId: input.studyId, answerId: input.answerId };
beforeEach(() => { vi.stubEnv('SESSION_SECRET', 'synthetic-exploration-save-only-signing-secret'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('save-only exploration receipts', () => {
  it('round-trips a bounded generated result and exact request fingerprint', async () => {
    const receipt = await signExplorationReceipt(input, identity.researcherId);
    expect(await verifyExplorationReceipt(receipt, identity)).toEqual(input);
  });

  it.each([
    { ...identity, researcherId: 'researcher-b' },
    { ...identity, researcherId: null },
    { ...identity, studyId: 'another-study' },
    { ...identity, answerId: 'another-answer' },
  ])('cannot transfer save authority to another identity (%j)', async (other) => {
    const receipt = await signExplorationReceipt(input, identity.researcherId);
    expect(await verifyExplorationReceipt(receipt, other)).toBeNull();
  });

  it('supports standalone authority without converting it into a hosted researcher identity', async () => {
    const receipt = await signExplorationReceipt(input, null);
    expect(await verifyExplorationReceipt(receipt, { ...identity, researcherId: null })).toEqual(input);
    expect(await verifyExplorationReceipt(receipt, identity)).toBeNull();
  });

  it('rejects payload/signature tampering rather than trusting browser asserted result or provenance', async () => {
    const receipt = await signExplorationReceipt(input, identity.researcherId);
    const parts = receipt.split('.');
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    claims.input.result.answer = 'Browser-invented evidence.';
    parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(await verifyExplorationReceipt(parts.join('.'), identity)).toBeNull();
  });

  it('expires after 24 hours and cannot authorize a later save', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    const receipt = await signExplorationReceipt(input, identity.researcherId);
    vi.setSystemTime(new Date('2026-09-30T12:00:01Z'));
    expect(await verifyExplorationReceipt(receipt, identity)).toBeNull();
  });

  it.each(['openinterviewer:researcher', 'openinterviewer:participant-session'])('refuses another JWT audience (%s), even with the same signature key', async (audience) => {
    const receipt = await new jose.SignJWT({ type: 'exploration-save', version: 1, input, researcherId: identity.researcherId })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(TOKEN_ISSUER).setAudience(audience)
      .setSubject(input.studyId).setIssuedAt().setExpirationTime('1h').sign(getResearcherArtifactSigningSecret());
    expect(await verifyExplorationReceipt(receipt, identity)).toBeNull();
  });

  it('refuses invalid result shapes before issuing a signed receipt', async () => {
    await expect(signExplorationReceipt({ ...input, result: { ...input.result, answer: 'x'.repeat(20_001) } }, identity.researcherId)).rejects.toThrow(/Invalid exploration receipt input/);
    expect(await verifyExplorationReceipt('x'.repeat(300_001), identity)).toBeNull();
  });
});
