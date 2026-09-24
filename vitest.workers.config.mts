// Real local Worker/SQLite/alarm/Queue tests (VERIFY-01). Runs the production
// WorkspaceStore and Queue consumer in workerd via @cloudflare/vitest-plugin.
// Storage is isolated per test file; tests sharing a file reset deliberately.
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './cloudflare/test/wrangler.test.jsonc' },
      remoteBindings: false,
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
