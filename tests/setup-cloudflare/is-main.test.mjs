// isMain (scripts/cloudflare/lib.mjs) decides whether a check script runs its
// work. It must never make a script skip its checks and exit 0: not on a Node
// without import.meta.main, not through a symlink, not from a checkout path
// that needs percent-encoding.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isMain } from '../../scripts/cloudflare/lib.mjs';

test('uses import.meta.main when the runtime provides it', () => {
  assert.equal(isMain({ main: true, url: 'file:///nowhere.mjs' }), true);
  assert.equal(isMain({ main: false, url: pathToFileURL(process.argv[1]).href }), false);
});

test('without import.meta.main, falls back to comparing real paths (older Node, symlinks, encoded paths)', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oi is-main #%é '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'entry script.mjs');
  const link = path.join(dir, 'linked.mjs');
  writeFileSync(script, '');
  symlinkSync(script, link);
  const meta = { url: pathToFileURL(script).href };
  const argv = process.argv[1];
  try {
    process.argv[1] = script;
    assert.equal(isMain(meta), true, 'direct path');
    process.argv[1] = link;
    assert.equal(isMain(meta), true, 'symlinked path');
    process.argv[1] = path.join(dir, 'other.mjs');
    assert.equal(isMain(meta), false, 'another script');
  } finally {
    process.argv[1] = argv;
  }
});
