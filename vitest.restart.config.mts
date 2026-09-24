// Restart lane (VERIFY-01): the prebuilt production Worker from
// dist/cloudflare/artifact runs in a child process (tests/cloudflare-restart/
// runner.mjs) with Durable Object, alarm and Queue state persisted in a
// runner-owned temporary directory. Tests SIGKILL that process group and start
// a new runner on the same directory, then observe persisted state only
// through the real Worker API. Requires `npm run build:cloudflare` first.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/cloudflare-restart/**/*.test.ts'],
    testTimeout: 360_000,
    hookTimeout: 120_000,
    // The files hold independent workspaces in separate state directories;
    // running them side by side keeps the lease-expiry wait off the critical path.
    fileParallelism: true,
  },
});
