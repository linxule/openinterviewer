// Integration/fault-harness vitest config (Revision 12 §18/§21).
// The base config scans only tests/unit; the real-Redis fault harness lives in
// tests/integration and runs under node (not jsdom). The dedicated scripts
// test:redis-crash / test:adversarial select their files via positional
// filters against this config. Everything else mirrors the base config so a
// shared test file behaves identically under both configs.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/unit/**/*.test.{ts,tsx}',
      'tests/integration/**/*.test.{ts,tsx}',
    ],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
