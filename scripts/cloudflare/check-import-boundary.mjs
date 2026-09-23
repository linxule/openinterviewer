#!/usr/bin/env node
// Import boundary for the Worker-only graph (gap review F12, IMPLEMENTATION.md
// §1). The Queue consumer and the WorkspaceStore Durable Object are bundled by
// wrangler, outside the Next build; they must never reach Next, the Redis
// backends or the Upstash client. Bundles each entry with esbuild (workerd
// conditions, as wrangler does) and inspects the resulting module graph.

import { build } from 'esbuild';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const ENTRIES = ['cloudflare/analysis/consumer.ts', 'cloudflare/workspace/WorkspaceStore.ts'];
const FORBIDDEN = [
  { pattern: /(^|\/)node_modules\/next\//, reason: 'Next.js runtime' },
  { pattern: /(^|\/)node_modules\/@upstash\/redis\//, reason: 'Upstash client' },
  { pattern: /(^|\/)node_modules\/redis\//, reason: 'node-redis client' },
  { pattern: /(^|\/)src\/lib\/kv\.ts$/, reason: 'Redis storage module' },
  { pattern: /(^|\/)src\/lib\/kvClient\.ts$/, reason: 'Redis client factory' },
  { pattern: /(^|\/)src\/lib\/redisNodeAdapter\.ts$/, reason: 'node-redis adapter' },
  { pattern: /(^|\/)src\/lib\/platformDb[^/]*\.ts$/, reason: 'hosted platform database' },
  { pattern: /(^|\/)src\/lib\/storage\/redis\.ts$/, reason: 'Redis WorkspaceStore' },
];

export async function inspectBoundary() {
  const violations = [];
  for (const entry of ENTRIES) {
    const result = await build({
      entryPoints: [path.join(ROOT, entry)],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'neutral',
      format: 'esm',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['browser', 'module', 'main'],
      external: ['cloudflare:*', 'node:*'],
      alias: { '@': path.join(ROOT, 'src') },
      logLevel: 'silent',
      tsconfig: path.join(ROOT, 'cloudflare', 'tsconfig.json'),
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      const normalized = input.split(path.sep).join('/');
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(normalized)) violations.push({ entry, input: normalized, reason: rule.reason });
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await inspectBoundary();
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`✗ ${violation.entry} reaches ${violation.input} (${violation.reason})`);
    }
    process.exit(1);
  }
  console.log(`✓ Worker-only graph (${ENTRIES.join(', ')}) reaches no Next, Redis or hosted modules`);
}
