// Credential generation and protected input (SETUP-02). Values live only in
// memory: they are never logged, written into state files or passed in argv.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import {
  EPOCH_SECRET,
  GENERATED_SECRETS,
  InstallerError,
  MAX_LOGIN_BODY_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_SECRET,
  PROVIDER_KEYS,
  REFUSED,
  SECRET_PLACEHOLDERS,
  loginBodyBytes,
} from './model.mjs';

export const generateWorkspaceId = () => `ws_${randomBytes(16).toString('hex')}`;
export const generateEpoch = () => `ep_${randomBytes(16).toString('hex')}`;
export const generateSecret = () => randomBytes(32).toString('base64url');

/** Non-secret fingerprint recorded in the receipt instead of the epoch. */
export const epochFingerprint = (epoch) => `sha256:${createHash('sha256').update(epoch).digest('hex').slice(0, 16)}`;

function refuse(message) {
  return new InstallerError(message, { exitCode: REFUSED });
}

/** Validate one supplied credential. Messages name the credential, never its value. */
export function validateSuppliedSecret(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw refuse(`${name} is blank`);
  if (value.trim() !== value) throw refuse(`${name} has leading or trailing whitespace`);
  if (value.length > 4096) throw refuse(`${name} is longer than 4096 characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw refuse(`${name} contains control characters`);
  if (SECRET_PLACEHOLDERS.test(value)) throw refuse(`${name} still contains a template placeholder`);
  if (name === PASSWORD_SECRET && value.length < MIN_PASSWORD_LENGTH) {
    throw refuse(`${PASSWORD_SECRET} must contain at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (name === PASSWORD_SECRET && loginBodyBytes(value) > MAX_LOGIN_BODY_BYTES) {
    throw refuse(
      `${PASSWORD_SECRET} is too long: its sign-in request body would be ${loginBodyBytes(value)} bytes and Cloudflare sign-in accepts at most `
        + `${MAX_LOGIN_BODY_BYTES} (about 1,000 ASCII characters; fewer with multi-byte characters or characters JSON must escape)`,
    );
  }
  return value;
}

/** Every credential in the set must be independent. */
export function assertIndependent(values) {
  const seen = new Map();
  for (const [name, value] of Object.entries(values)) {
    if (seen.has(value)) throw refuse(`${name} reuses the value of ${seen.get(value)}; every credential must be independent`);
    seen.set(value, name);
  }
}

async function readAllStdin() {
  if (process.stdin.isTTY) throw refuse('--secrets-stdin expects JSON piped on stdin, not a terminal');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function promptHidden(label) {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new InstallerError('cancelled', { exitCode: 130 }));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stderr.write(`${label} (input hidden): `);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Read the named credentials from stdin JSON (`--secrets-stdin`) or a
 * no-echo terminal prompt. Returns { NAME: value }.
 */
export async function readProtectedInput(names, { fromStdin }) {
  if (fromStdin) {
    let body;
    try {
      body = JSON.parse(await readAllStdin());
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      throw refuse('--secrets-stdin input is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('--secrets-stdin input must be a JSON object');
    const unexpected = Object.keys(body).filter((key) => !names.includes(key));
    if (unexpected.length > 0) {
      throw refuse(`--secrets-stdin received unexpected names: ${unexpected.join(', ')} (expected exactly ${names.join(', ')})`);
    }
    const values = {};
    for (const name of names) {
      if (!Object.hasOwn(body, name)) throw refuse(`--secrets-stdin input lacks ${name}`);
      values[name] = validateSuppliedSecret(name, body[name]);
    }
    return values;
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw refuse('credentials need protected input: pipe JSON with --secrets-stdin, or run in an interactive terminal');
  }
  const values = {};
  for (const name of names) {
    const value = validateSuppliedSecret(name, await promptHidden(name));
    if (name === PASSWORD_SECRET) {
      const again = await promptHidden(`${name} again`);
      if (again !== value) throw refuse(`${name} entries do not match`);
    }
    values[name] = value;
  }
  return values;
}

/** Operator-supplied credentials for a fresh install. */
export function suppliedSecretNames(provider) {
  return [PASSWORD_SECRET, PROVIDER_KEYS[provider]];
}

/** The complete initial secret set: generated values plus supplied ones. */
export function composeSecretSet({ supplied, provider, epoch }) {
  const values = {
    [PASSWORD_SECRET]: supplied[PASSWORD_SECRET],
    [PROVIDER_KEYS[provider]]: supplied[PROVIDER_KEYS[provider]],
    [EPOCH_SECRET]: epoch,
  };
  for (const name of GENERATED_SECRETS) values[name] = generateSecret();
  assertIndependent(values);
  return values;
}

function realpathOfExistingAncestor(target) {
  let current = path.resolve(target);
  const rest = [];
  while (!existsSync(current)) {
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(realpathSync(current), ...rest);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validate --operator-token-file. The file must be outside the repository
 * and the installer state directory, its directory must not let other users
 * swap entries (group/world-writable without the sticky bit), and it must
 * not already exist unless this installation wrote it in an interrupted
 * attempt (`previousFile`). Returns { file, overwrite }.
 */
export function resolveOperatorTokenFile(raw, { root, stateDir, previousFile }) {
  const target = path.resolve(raw);
  const parent = path.dirname(target);
  if (!existsSync(parent)) throw refuse(`--operator-token-file directory ${parent} does not exist`);
  const real = path.join(realpathSync(parent), path.basename(target));
  if (isInside(real, realpathSync(root))) throw refuse('--operator-token-file must be outside the repository');
  if (isInside(real, realpathOfExistingAncestor(stateDir))) throw refuse('--operator-token-file must be outside the installer state directory');
  const parentMode = statSync(parent).mode;
  if ((parentMode & 0o022) !== 0 && (parentMode & 0o1000) === 0) {
    throw refuse(`--operator-token-file directory ${parent} is writable by other users without the sticky bit; choose a private directory`);
  }
  if (existsSync(target) || isSymlink(target)) {
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) throw refuse('--operator-token-file exists and is not a regular file');
    if (previousFile !== target) throw refuse(`--operator-token-file ${target} already exists; choose a new path`);
    return { file: target, overwrite: true };
  }
  return { file: target, overwrite: false };
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

const { O_CREAT, O_EXCL, O_WRONLY } = fsConstants;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Write the token without following links. A new file is created
 * exclusively; an overwrite (a file this installation wrote in an
 * interrupted attempt) must still be the same private regular file.
 * Either way the path was checked minutes earlier, so it is re-checked here.
 */
export function writeOperatorTokenFile({ file, overwrite }, token) {
  let fd;
  try {
    if (overwrite) {
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink()) throw refuse(`--operator-token-file ${file} is no longer a regular file; refusing to write the token`);
      fd = openSync(file, O_WRONLY | O_NOFOLLOW);
      const opened = fstatSync(fd);
      const ownerOk = typeof process.getuid !== 'function' || opened.uid === process.getuid();
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.nlink !== 1 || !ownerOk) {
        throw refuse(`--operator-token-file ${file} changed since it was checked; refusing to write the token`);
      }
      ftruncateSync(fd, 0);
    } else {
      fd = openSync(file, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
    }
    fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    if (error.code === 'EEXIST' || error.code === 'ELOOP') {
      throw refuse(`--operator-token-file ${file} appeared or became a link after it was checked; refusing to write the token`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
