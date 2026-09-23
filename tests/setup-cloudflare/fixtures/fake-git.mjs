#!/usr/bin/env node
// Fake git answering the two read-only queries the installer makes, from
// the shared fake state (state.git = { commit, dirty }).

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
  process.stdout.write(state.git.dirty ? ' M src/app/page.tsx\n' : '');
  process.exit(0);
}
process.stderr.write(`fake git: unsupported ${JSON.stringify(argv)}\n`);
process.exit(1);
