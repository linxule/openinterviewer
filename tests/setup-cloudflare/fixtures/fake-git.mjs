#!/usr/bin/env node
// Fake git answering the two read-only queries the installer makes, from
// the shared fake state (state.git = { commit, dirty, untracked? }). Like
// real git, untracked paths are listed unless --untracked-files=no.

import { invocation, readState, writeState } from './fake-state.mjs';

const argv = process.argv.slice(2);
const state = readState();
state.invocations.push(invocation('git', argv));
writeState(state);

if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
  process.stdout.write(`${state.git.commit}\n`);
  process.exit(0);
}
if (argv[0] === 'status') {
  const lines = state.git.dirty ? [' M src/app/page.tsx'] : [];
  if (!argv.includes('--untracked-files=no')) for (const file of state.git.untracked ?? []) lines.push(`?? ${file}`);
  process.stdout.write(lines.map((line) => `${line}\n`).join(''));
  process.exit(0);
}
process.stderr.write(`fake git: unsupported ${JSON.stringify(argv)}\n`);
process.exit(1);
