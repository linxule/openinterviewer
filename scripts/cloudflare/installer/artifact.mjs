// Artifact readiness: the same preconditions scripts/cloudflare/deploy.mjs
// enforces, checked up front so apply/update refuse before any remote write.
// deploy.mjs re-checks everything itself; this is not a substitute gate.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File, sha256Tree } from '../lib.mjs';
import { gitState } from './tools.mjs';

export async function artifactStatus({ root, artifactDir, git }) {
  const problems = [];
  const manifestPath = path.join(artifactDir, 'manifest.json');
  const receiptPath = path.join(artifactDir, 'receipt.json');
  let source;
  try {
    source = await gitState(git, root);
  } catch (error) {
    return { ready: false, commit: null, workerSha256: null, problems: [error.message] };
  }
  if (source.dirty) problems.push('checkout has uncommitted tracked changes');
  if (!existsSync(manifestPath)) {
    problems.push('no artifact manifest (run npm run build:cloudflare)');
    return { ready: false, commit: source.commit, workerSha256: null, problems };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    problems.push('artifact manifest is not valid JSON');
    return { ready: false, commit: source.commit, workerSha256: null, problems };
  }
  if (manifest.source?.commit !== source.commit) problems.push('artifact was built from a different commit');
  if (manifest.source?.dirty) problems.push('artifact was built from a dirty tree');
  if (manifest.lockfileSha256 !== sha256File(path.join(root, 'package-lock.json'))) problems.push('package-lock.json changed since build');
  if (manifest.templateConfigSha256 !== sha256File(path.join(root, 'wrangler.jsonc'))) problems.push('wrangler.jsonc changed since build');
  for (const [dir, field, label] of [['worker', 'workerSha256', 'worker bundle'], ['assets', 'assetsSha256', 'assets']]) {
    const full = path.join(artifactDir, dir);
    if (!existsSync(full)) problems.push(`artifact ${dir}/ directory is missing`);
    else if (sha256Tree(full).sha256 !== manifest.artifact?.[field]) problems.push(`${label} differs from manifest`);
  }
  if (!existsSync(receiptPath)) {
    problems.push('no passing release-check receipt (run the local release check for this artifact)');
  } else {
    let receipt = null;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      problems.push('release-check receipt is not valid JSON');
    }
    if (receipt) {
      if (receipt.status !== 'passed') problems.push('release-check receipt is not passing');
      if (receipt.artifact?.workerSha256 !== manifest.artifact?.workerSha256) problems.push('receipt belongs to another artifact');
      if (receipt.source?.commit !== manifest.source?.commit) problems.push('receipt belongs to another commit');
    }
  }
  return {
    ready: problems.length === 0,
    commit: source.commit,
    workerSha256: manifest.artifact?.workerSha256 ?? null,
    problems,
  };
}
