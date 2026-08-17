// Disposable real-Redis fault harness (Revision 12 §18).
//
// Always creates a unique disposable Redis container (local and CI). The
// container ID is recorded to a per-run attestation file and is the removal
// handle — never a reusable name. Never FLUSHDB an arbitrary preset loopback
// URL.
//
// Ownership: mints ownershipToken = randomBytes(32).hex and brands the
// node-redis adapter with the exact `redis://` URL + token. Fault seams refuse
// unless the brand matches.
//
// CI alternative: a job-level Redis service is allowed only if the job writes
// the same ownership attestation file (`url`, `containerId` or
// `serviceName+nonce`, `ownershipToken`) and points tests at it via the
// REDIS_ATTESTATION_FILE env (or the attestationFile option). In that mode
// tests refuse to start without a valid attestation — the harness never
// creates a container for an explicitly requested attestation. The default
// (no env, no option) is the created container.
//
// Teardown: docker rm -f <recordedId> (never by name). Adopted CI containers
// are left for the job to clean up.

import { randomBytes } from 'crypto';
import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { createRedisNodeAdapter, type RedisNodeAdapter } from '../../src/lib/redisNodeAdapter';

const execFileAsync = promisify(execFile);

export const REDIS_ATTESTATION_FILE_ENV = 'REDIS_ATTESTATION_FILE';

export interface RedisAttestation {
  url: string;
  containerId: string;
  ownershipToken: string;
  createdAt: number;
}

export interface DisposableRedis {
  url: string;
  containerId: string;
  ownershipToken: string;
  /** Branded node-redis adapter (dev/test only). */
  adapter(): RedisNodeAdapter;
  /** Closes the adapter, then docker rm -f <recorded containerId>. */
  close(): Promise<void>;
}

export const DEFAULT_REDIS_IMAGE = 'redis:7-alpine';

/**
 * Per-run run file (PID + random suffix): parallel vitest workers and
 * concurrent runs never share or clobber one attestation path.
 */
export function defaultAttestationFile(): string {
  return path.join(
    os.tmpdir(),
    `openinterviewer-redis-attestation-${process.pid}-${randomBytes(4).toString('hex')}.json`
  );
}

export function isRedisAttestation(value: unknown): value is RedisAttestation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.url === 'string'
    && candidate.url.startsWith('redis://')
    && typeof candidate.containerId === 'string'
    && candidate.containerId.length > 0
    && typeof candidate.ownershipToken === 'string'
    && /^[0-9a-f]{64}$/.test(candidate.ownershipToken)
  );
}

/** Parse + validate an attestation file body; null when unusable. */
export function parseAttestationFile(raw: string): RedisAttestation | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRedisAttestation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Branded adapter from a recorded attestation (no I/O). */
export function adapterFromAttestation(attestation: RedisAttestation): RedisNodeAdapter {
  return createRedisNodeAdapter({
    url: attestation.url,
    ownershipToken: attestation.ownershipToken,
  });
}

async function readAttestation(file: string): Promise<RedisAttestation | null> {
  try {
    return parseAttestationFile(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAttestation(file: string, attestation: RedisAttestation): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { timeout: 120_000 });
  return stdout.trim();
}

function redisServerPid(handle: string): number | null {
  if (!handle.startsWith('redis-server+')) return null;
  const pid = Number(handle.split('+')[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port for owned Redis'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForOwnedRedis(url: string, ownershipToken: string): Promise<void> {
  const adapter = createRedisNodeAdapter({
    url,
    ownershipToken,
    socket: { reconnectStrategy: () => false, connectTimeout: 500 },
  });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const pong = await adapter.ping();
        if (typeof pong === 'string' && pong.toUpperCase() === 'PONG') return;
      } catch {
        // owned instance still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Owned Redis at ${url} did not become ready`);
  } finally {
    await adapter.close().catch(() => {});
  }
}

async function startOwnedRedisServer(): Promise<{ url: string; containerId: string; dataDir: string }> {
  const redisServer = process.env.OI_REDIS_SERVER_BIN || 'redis-server';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oi-owned-redis-'));
  const port = await findFreePort();
  const child = spawn(
    redisServer,
    [
      '--bind', '127.0.0.1',
      '--port', String(port),
      '--dir', dataDir,
      '--dbfilename', 'dump.rdb',
      '--save', '',
      '--appendonly', 'no',
      '--protected-mode', 'yes',
      '--daemonize', 'no',
    ],
    { stdio: 'ignore' }
  );
  if (!child.pid) {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error('Owned redis-server failed to start (no pid)');
  }
  const containerId = `redis-server+${child.pid}+${randomBytes(4).toString('hex')}`;
  child.once('exit', () => {
    void fs.rm(dataDir, { recursive: true, force: true });
  });
  return { url: `redis://127.0.0.1:${port}`, containerId, dataDir };
}

async function isContainerRunning(handle: string): Promise<boolean> {
  const pid = redisServerPid(handle);
  if (pid !== null) return isProcessRunning(pid);
  // CI services may record `serviceName+nonce`; match by container id first,
  // then by name. Any docker failure (daemon down, binary missing) means the
  // handle is not running.
  for (const filter of [`id=${handle}`, `name=${handle}`]) {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '--filter', filter, '--format', '{{.ID}}'],
        { timeout: 30_000 }
      );
      if (stdout.trim().length > 0) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Start (or adopt) a disposable Redis instance and record the attestation.
 *
 * - No attestation file: always create a unique container (local default).
 * - Valid attestation file whose container/service is running: adopt it (CI
 *   service path). Adopted containers are never removed by close().
 * - attestationFile option or REDIS_ATTESTATION_FILE env set but no valid
 *   attestation: refuse to start — the job's service is missing or broken.
 */
export async function startDisposableRedis(options: {
  attestationFile?: string;
  image?: string;
} = {}): Promise<DisposableRedis> {
  const explicit =
    options.attestationFile !== undefined
    || process.env[REDIS_ATTESTATION_FILE_ENV] !== undefined;
  const attestationFile =
    options.attestationFile
    ?? process.env[REDIS_ATTESTATION_FILE_ENV]
    ?? defaultAttestationFile();

  const existing = await readAttestation(attestationFile);
  if (existing) {
    if (!(await isContainerRunning(existing.containerId))) {
      throw new Error(
        `Redis attestation ${attestationFile} exists but container/service ${existing.containerId} is not running`
      );
    }
    return buildHandle(existing, attestationFile, { ownsContainer: false, ownsFile: false });
  }

  if (explicit) {
    throw new Error(
      `Redis attestation ${attestationFile} is required (REDIS_ATTESTATION_FILE / attestationFile) but missing or invalid; refusing to start without it`
    );
  }

  // Default: create a unique owned instance. Prefer a docker container; if the
  // daemon is down, fall back to a runner-owned redis-server bound to a fresh
  // 127.0.0.1 port and isolated datadir. Never inherit REDIS_URL / FLUSHDB.
  if (process.env.REDIS_URL) {
    throw new Error('REDIS_URL is set; refusing to adopt an inherited Redis (owned container/process only)');
  }

  const ownershipToken = randomBytes(32).toString('hex');
  let url: string;
  let containerId: string;
  try {
    const name = `openinterviewer-redis-${randomBytes(6).toString('hex')}`;
    containerId = await docker(
      'run', '-d', '--name', name, '-p', '127.0.0.1::6379',
      options.image ?? DEFAULT_REDIS_IMAGE
    );
    const portLine = await docker('port', containerId, '6379');
    const hostPort = portLine.trim().split(':').pop();
    if (!hostPort || !/^[0-9]+$/.test(hostPort)) {
      await docker('rm', '-f', containerId).catch(() => {});
      throw new Error(`Could not determine host port for container ${containerId}`);
    }
    url = `redis://127.0.0.1:${hostPort}`;
  } catch (dockerError) {
    try {
      const started = await startOwnedRedisServer();
      url = started.url;
      containerId = started.containerId;
      ownedDataDirs.set(containerId, started.dataDir);
    } catch (serverError) {
      throw new Error(
        `Could not start a runner-owned Redis (docker: ${String(dockerError)}; redis-server: ${String(serverError)})`
      );
    }
  }
  const attestation: RedisAttestation = {
    url,
    containerId,
    ownershipToken,
    createdAt: Date.now(),
  };
  await writeAttestation(attestationFile, attestation);
  try {
    await waitForOwnedRedis(url, ownershipToken);
  } catch (error) {
    if (redisServerPid(containerId) !== null) {
      const pid = redisServerPid(containerId);
      if (pid) process.kill(pid, 'SIGTERM');
      const dir = ownedDataDirs.get(containerId);
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    } else {
      await docker('rm', '-f', containerId).catch(() => {});
    }
    await fs.rm(attestationFile, { force: true }).catch(() => {});
    throw error;
  }
  return buildHandle(attestation, attestationFile, { ownsContainer: true, ownsFile: true });
}

const ownedDataDirs = new Map<string, string>();

function buildHandle(
  attestation: RedisAttestation,
  attestationFile: string,
  owned: { ownsContainer: boolean; ownsFile: boolean }
): DisposableRedis {
  let adapter: RedisNodeAdapter | null = null;
  return {
    url: attestation.url,
    containerId: attestation.containerId,
    ownershipToken: attestation.ownershipToken,
    adapter() {
      if (!adapter) {
        adapter = adapterFromAttestation(attestation);
      }
      return adapter;
    },
    async close() {
      if (adapter) {
        await adapter.close().catch(() => {});
      }
      if (owned.ownsContainer) {
        // Removal handle is the recorded ID, never a reusable name.
        const pid = redisServerPid(attestation.containerId);
        if (pid !== null) {
          if (isProcessRunning(pid)) process.kill(pid, 'SIGTERM');
          const dir = ownedDataDirs.get(attestation.containerId);
          if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          ownedDataDirs.delete(attestation.containerId);
        } else {
          await docker('rm', '-f', attestation.containerId).catch(() => {});
        }
      }
      if (owned.ownsFile) {
        await fs.rm(attestationFile, { force: true }).catch(() => {});
      }
    },
  };
}
