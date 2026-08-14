// Versioned AES-256-GCM envelopes for researcher credentials stored in the
// platform database. New writes identify the key used so operators can rotate
// keys without making existing credentials unreadable.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENVELOPE_VERSION = 'v2';
const PREVIOUS_ENVELOPE_VERSION = 'v1';
const LEGACY_KEY_ID = 'legacy';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface CredentialKeyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
  legacyKey: Buffer | null;
}

export type CredentialPurpose =
  | 'redis-url'
  | 'redis-token'
  | 'gemini-api-key'
  | 'anthropic-api-key';

export interface CredentialEncryptionContext {
  researcherId: string;
  purpose: CredentialPurpose;
}

function decodeKey(keyBase64: string, source: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) {
    throw new Error(`${source} must contain a base64-encoded 256-bit (32 byte) key`);
  }
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error(`${source} must contain a base64-encoded 256-bit (32 byte) key`);
  }
  return key;
}

function loadKeyring(): CredentialKeyring {
  const keys = new Map<string, Buffer>();
  const serializedKeyring = process.env.CREDENTIAL_ENCRYPTION_KEYS;
  const activeKeyId = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID;
  const legacyValue = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const legacyKey = legacyValue
    ? decodeKey(legacyValue, 'CREDENTIAL_ENCRYPTION_KEY')
    : null;

  if (serializedKeyring) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serializedKeyring);
    } catch {
      throw new Error('CREDENTIAL_ENCRYPTION_KEYS must be a JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEYS must be a JSON object');
    }

    for (const [keyId, value] of Object.entries(parsed)) {
      if (keyId === LEGACY_KEY_ID || !KEY_ID_PATTERN.test(keyId) || typeof value !== 'string' || !value) {
        throw new Error('CREDENTIAL_ENCRYPTION_KEYS contains an invalid key entry');
      }
      keys.set(keyId, decodeKey(value, `CREDENTIAL_ENCRYPTION_KEYS.${keyId}`));
    }

    if (!activeKeyId || !KEY_ID_PATTERN.test(activeKeyId)) {
      throw new Error('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID is required with CREDENTIAL_ENCRYPTION_KEYS');
    }
    if (!keys.has(activeKeyId)) {
      throw new Error('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID is not present in CREDENTIAL_ENCRYPTION_KEYS');
    }

    if (legacyKey) keys.set(LEGACY_KEY_ID, legacyKey);
    return { activeKeyId, keys, legacyKey };
  }

  if (activeKeyId) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEYS is required with CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID');
  }
  if (!legacyKey) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEYS and CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID are required in hosted mode'
    );
  }

  keys.set(LEGACY_KEY_ID, legacyKey);
  return { activeKeyId: LEGACY_KEY_ID, keys, legacyKey };
}

function validateContext(context: CredentialEncryptionContext): void {
  if (
    !context
    || typeof context.researcherId !== 'string'
    || !context.researcherId.trim()
    || context.researcherId.length > 256
    || ![
      'redis-url',
      'redis-token',
      'gemini-api-key',
      'anthropic-api-key',
    ].includes(context.purpose)
  ) {
    throw new Error('Credential encryption context is invalid');
  }
}

function associatedData(
  version: string,
  keyId: string,
  context?: CredentialEncryptionContext
): Buffer {
  if (version === PREVIOUS_ENVELOPE_VERSION) {
    return Buffer.from(`openinterviewer:credential:${version}:${keyId}`, 'utf8');
  }
  if (!context) throw new Error('Credential encryption context is required');
  validateContext(context);
  return Buffer.from(JSON.stringify([
    'openinterviewer',
    'credential',
    version,
    keyId,
    context.researcherId,
    context.purpose,
  ]), 'utf8');
}

function decodePart(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Credential envelope is malformed');
  }
  return Buffer.from(value, 'base64url');
}

// Current envelope: v2.<key id>.<iv>.<ciphertext>.<authentication tag>.
// v2 binds ciphertext to a researcher and credential field using GCM AAD.
export function encrypt(plaintext: string, context: CredentialEncryptionContext): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty credential');
  }

  const keyring = loadKeyring();
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error('Active credential encryption key is unavailable');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(ENVELOPE_VERSION, keyring.activeKeyId, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    keyring.activeKeyId,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join('.');
}

function decryptVersioned(
  parts: string[],
  keyring: CredentialKeyring,
  context?: CredentialEncryptionContext
): string {
  if (parts.length !== 5 || !KEY_ID_PATTERN.test(parts[1])) {
    throw new Error('Credential envelope is malformed');
  }

  const [version, keyId, encodedIv, encodedCiphertext, encodedTag] = parts;
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error('Credential encryption key is unavailable');

  const iv = decodePart(encodedIv);
  const ciphertext = decodePart(encodedCiphertext);
  const authTag = decodePart(encodedTag);
  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH || ciphertext.length === 0) {
    throw new Error('Credential envelope is malformed');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(associatedData(version, keyId, context));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptLegacy(packed: string, keyring: CredentialKeyring): string {
  if (!keyring.legacyKey) {
    throw new Error('Legacy credential encryption key is unavailable');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) {
    throw new Error('Credential envelope is malformed');
  }

  const data = Buffer.from(packed, 'base64');
  if (data.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Credential envelope is malformed');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, keyring.legacyKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decrypt(packed: string, context: CredentialEncryptionContext): string {
  if (typeof packed !== 'string' || packed.length === 0) {
    throw new Error('Credential envelope is malformed');
  }

  const keyring = loadKeyring();
  const parts = packed.split('.');
  if (parts[0] === ENVELOPE_VERSION || parts[0] === PREVIOUS_ENVELOPE_VERSION) {
    return decryptVersioned(parts, keyring, parts[0] === ENVELOPE_VERSION ? context : undefined);
  }

  // Backward compatibility for the original base64(iv+ciphertext+tag) format.
  // Only the explicitly retained legacy key is tried.
  return decryptLegacy(packed, keyring);
}

export function getCredentialEnvelopeKeyId(packed: string): string | null {
  const parts = packed.split('.');
  return parts.length === 5
    && (parts[0] === ENVELOPE_VERSION || parts[0] === PREVIOUS_ENVELOPE_VERSION)
    && KEY_ID_PATTERN.test(parts[1])
    ? parts[1]
    : null;
}
