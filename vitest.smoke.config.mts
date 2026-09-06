// Live-provider smoke config. Never part of `npm run check`; run explicitly
// with a single provider selected and only that provider's credential in the
// environment. See tests/smoke/provider-provenance.smoke.test.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.smoke.test.ts'],
    testTimeout: 150_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
