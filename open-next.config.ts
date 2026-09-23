import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental/tag cache: every researcher/participant surface is dynamic and
// private, so the adapter's R2/KV/D1 cache bindings are intentionally absent.
const config = defineCloudflareConfig({});

// The adapter's cloudflare-node wrapper acknowledges every response write at
// once, so streamed responses ignore client backpressure and can fill Worker
// memory. This wrapper is the same code with backpressure (see its header).
// @opennextjs/cloudflare validates the wrapper by name only, so that
// validation is disabled; tests/unit/openNextConfig.test.ts asserts that every
// other field still equals defineCloudflareConfig({}).
config.default.override!.wrapper = async () => (await import('./cloudflare/opennext/backpressureWrapper')).default;
config.cloudflare = { ...config.cloudflare, dangerousDisableConfigValidation: true };

export default config;
