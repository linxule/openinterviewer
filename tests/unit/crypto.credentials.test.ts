import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, getCredentialEnvelopeKeyId } from '@/lib/crypto';

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');
const legacyKey = Buffer.alloc(32, 3);
const redisUrlContext = { researcherId: 'researcher-a', purpose: 'redis-url' as const };
const redisTokenContext = { researcherId: 'researcher-a', purpose: 'redis-token' as const };

const originalEnv = {
  keyring: process.env.CREDENTIAL_ENCRYPTION_KEYS,
  active: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
  legacy: process.env.CREDENTIAL_ENCRYPTION_KEY,
};

afterEach(() => {
  if (originalEnv.keyring === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEYS;
  else process.env.CREDENTIAL_ENCRYPTION_KEYS = originalEnv.keyring;
  if (originalEnv.active === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;
  else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = originalEnv.active;
  if (originalEnv.legacy === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = originalEnv.legacy;
});

describe('credential encryption envelopes', () => {
  it('writes the active key ID and decrypts retained rotation keys', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ old: keyA, current: keyB });
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'old';
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    const oldEnvelope = encrypt('secret-a', redisUrlContext);

    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'current';
    const currentEnvelope = encrypt('secret-b', redisUrlContext);

    expect(getCredentialEnvelopeKeyId(oldEnvelope)).toBe('old');
    expect(getCredentialEnvelopeKeyId(currentEnvelope)).toBe('current');
    expect(decrypt(oldEnvelope, redisUrlContext)).toBe('secret-a');
    expect(decrypt(currentEnvelope, redisUrlContext)).toBe('secret-b');
  });

  it('binds ciphertext to the researcher and credential field', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ current: keyB });
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'current';
    const envelope = encrypt('secret', redisUrlContext);

    expect(() => decrypt(envelope, redisTokenContext)).toThrow();
    expect(() => decrypt(envelope, {
      researcherId: 'researcher-b',
      purpose: 'redis-url',
    })).toThrow();
  });

  it('decrypts the original unversioned envelope only with the explicit legacy key', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const ciphertext = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');

    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ current: keyB });
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'current';
    process.env.CREDENTIAL_ENCRYPTION_KEY = legacyKey.toString('base64');
    expect(decrypt(packed, redisUrlContext)).toBe('legacy-secret');

    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => decrypt(packed, redisUrlContext)).toThrow(/Legacy credential encryption key/);
  });

  it('fails closed for unknown key IDs and malformed keyrings', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ current: keyB });
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'current';
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    const envelope = encrypt('secret', redisUrlContext);

    process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ replacement: keyA });
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'replacement';
    expect(() => decrypt(envelope, redisUrlContext)).toThrow(/unavailable/);

    process.env.CREDENTIAL_ENCRYPTION_KEYS = '{bad json';
    expect(() => encrypt('secret', redisUrlContext)).toThrow(/JSON object/);
  });
});
