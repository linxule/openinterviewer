#!/usr/bin/env node
// Fails when iCloud Drive (or any sync client) has left conflict copies such as
// "route 2.ts" in the tree. Such a copy inside .next/types or tests/ silently
// breaks typecheck or duplicates a suite; catching it here names the cause.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git']);
const CONFLICT = /^.+ 2(\.[^/]*)?$/;
const found = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (CONFLICT.test(entry)) { found.push(path); continue; }
    let stats;
    try { stats = statSync(path); } catch { continue; }
    if (stats.isDirectory()) walk(path);
  }
}

walk('.');

if (found.length > 0) {
  console.error(`Sync-conflict copies found (${found.length}); delete them before running the gate:`);
  for (const path of found.slice(0, 20)) console.error(`  ${path}`);
  if (found.length > 20) console.error(`  ...and ${found.length - 20} more`);
  console.error('Remove all with: find . -path ./node_modules -prune -o \\( -name "* 2" -o -name "* 2.*" \\) -print -exec rm -rf {} +');
  process.exit(1);
}
