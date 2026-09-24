// Artifact readiness: the preconditions scripts/cloudflare/deploy.mjs
// enforces (its own verifyArtifact), checked up front so apply/update refuse
// before any remote write. deploy.mjs re-checks everything itself; this is
// not a substitute gate.

import { verifyArtifact } from '../deploy.mjs';
import { gitState } from './tools.mjs';

export async function artifactStatus({ root, artifactDir, git }) {
  let source;
  try {
    source = await gitState(git, root);
  } catch (error) {
    return { ready: false, commit: null, workerSha256: null, problems: [error.message] };
  }
  const { manifest, problems } = verifyArtifact({ root, artifactDir, git: source });
  return {
    ready: problems.length === 0,
    commit: source.commit,
    workerSha256: manifest?.artifact?.workerSha256 ?? null,
    problems,
  };
}
