// Production-artifact tests (VERIFY-01/02): run the prebuilt Worker bundle
// from dist/cloudflare/artifact in local workerd via wrangler's
// createTestHarness. Requires `npm run build:cloudflare` first. Outbound
// Worker fetches are proxied through this Node process, where tests install
// synthetic provider fixtures and reject every other destination.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/cloudflare-artifact/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
