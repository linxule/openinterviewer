import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental/tag cache: every researcher/participant surface is dynamic and
// private, so the adapter's R2/KV/D1 cache bindings are intentionally absent.
export default defineCloudflareConfig({});
