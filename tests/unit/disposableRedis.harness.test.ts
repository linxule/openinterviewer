// Disposable real-Redis harness (Revision 12 §18) — the unit-testable
// surface that needs no docker daemon: attestation validation, per-run run
// files, explicit-path refusal, branded adapter wiring, and the fault
// manifest bookkeeping. Container create/adopt/teardown is exercised by the
// real-Redis integration suites (Phase 6) where docker is available.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { computeRedisBrand } from '@/lib/redisNodeAdapter';
import {
  REDIS_ATTESTATION_FILE_ENV,
  adapterFromAttestation,
  defaultAttestationFile,
  isRedisAttestation,
  parseAttestationFile,
  startDisposableRedis,
  type RedisAttestation,
} from '../helpers/disposableRedis';
import {
  FAULT_CUTS,
  assertFaultCutsCovered,
  coverFaultCut,
  coveredFaultCuts,
  isFaultCutCovered,
} from '../helpers/faultManifest';

function mintAttestation(): RedisAttestation {
  return {
    url: 'redis://127.0.0.1:6379',
    containerId: randomBytes(12).toString('hex'),
    ownershipToken: randomBytes(32).toString('hex'),
    createdAt: Date.now(),
  };
}

describe('disposableRedis.harness: attestation validation', () => {
  it('accepts a well-formed attestation', () => {
    expect(isRedisAttestation(mintAttestation())).toBe(true);
  });

  it('rejects a non-hex ownership token', () => {
    const attestation = mintAttestation();
    attestation.ownershipToken = 'not-a-hex64-token';
    expect(isRedisAttestation(attestation)).toBe(false);
  });

  it('rejects a non-redis url', () => {
    const attestation = mintAttestation();
    attestation.url = 'http://127.0.0.1:6379';
    expect(isRedisAttestation(attestation)).toBe(false);
  });

  it('rejects a missing or empty container id', () => {
    const missing = mintAttestation();
    delete (missing as Partial<RedisAttestation>).containerId;
    expect(isRedisAttestation(missing)).toBe(false);

    const empty = mintAttestation();
    empty.containerId = '';
    expect(isRedisAttestation(empty)).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isRedisAttestation(null)).toBe(false);
    expect(isRedisAttestation('redis://x')).toBe(false);
  });

  it('parseAttestationFile round-trips valid JSON and rejects garbage', () => {
    const attestation = mintAttestation();
    const parsed = parseAttestationFile(JSON.stringify(attestation));
    expect(parsed).toEqual(attestation);
    expect(parseAttestationFile('not json')).toBeNull();
    expect(parseAttestationFile('42')).toBeNull();
    expect(parseAttestationFile(JSON.stringify({ url: 'redis://x' }))).toBeNull();
  });
});

describe('disposableRedis.harness: run files', () => {
  it('defaultAttestationFile is unique per run and lives in the tmpdir', () => {
    const first = defaultAttestationFile();
    const second = defaultAttestationFile();
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(os.tmpdir());
    expect(path.basename(first)).toMatch(/^openinterviewer-redis-attestation-.+\.json$/);
    expect(first).toContain(String(process.pid));
  });

  it('exposes the CI attestation env name', () => {
    expect(REDIS_ATTESTATION_FILE_ENV).toBe('REDIS_ATTESTATION_FILE');
  });
});

describe('disposableRedis.harness: explicit-path refusal (no docker needed)', () => {
  it('refuses when the explicit attestation file is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oi-harness-test-'));
    try {
      await expect(
        startDisposableRedis({ attestationFile: path.join(dir, 'missing.json') })
      ).rejects.toThrow(/missing or invalid/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the explicit attestation file is invalid', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oi-harness-test-'));
    try {
      const file = path.join(dir, 'attestation.json');
      await fs.writeFile(file, 'not json', 'utf8');
      await expect(startDisposableRedis({ attestationFile: file })).rejects.toThrow(
        /missing or invalid/
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a valid attestation whose container is not running', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oi-harness-test-'));
    try {
      const file = path.join(dir, 'attestation.json');
      await fs.writeFile(file, JSON.stringify(mintAttestation()), 'utf8');
      await expect(startDisposableRedis({ attestationFile: file })).rejects.toThrow(
        /not running/
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('disposableRedis.harness: branded adapter wiring', () => {
  it('adapterFromAttestation brands with the exact url and token', async () => {
    const attestation = mintAttestation();
    const adapter = adapterFromAttestation(attestation);
    expect(adapter.url).toBe(attestation.url);
    expect(adapter.brand).toBe(
      computeRedisBrand(attestation.url, attestation.ownershipToken)
    );
    await adapter.close();
  });
});

describe('disposableRedis.harness: fault manifest', () => {
  it('lists unique, non-empty cut ids', () => {
    expect(FAULT_CUTS.length).toBeGreaterThan(0);
    expect(new Set(FAULT_CUTS).size).toBe(FAULT_CUTS.length);
    for (const id of FAULT_CUTS) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    }
  });

  it('registers coverage and round-trips', () => {
    expect(isFaultCutCovered('R1')).toBe(false);
    coverFaultCut('R1');
    expect(isFaultCutCovered('R1')).toBe(true);
    expect(coveredFaultCuts()).toContain('R1');
  });

  it('assertFaultCutsCovered throws while any cut has no test', () => {
    // 'PUB1' is never covered in this file, so the assertion must fail.
    expect(isFaultCutCovered('PUB1')).toBe(false);
    expect(() => assertFaultCutsCovered()).toThrow(/Fault cuts without tests/);
    expect(() => assertFaultCutsCovered()).toThrow(/PUB1/);
  });

  it('assertFaultCutsCovered passes once every cut is covered', () => {
    for (const id of FAULT_CUTS) {
      coverFaultCut(id);
    }
    expect(() => assertFaultCutsCovered()).not.toThrow();
  });
});
