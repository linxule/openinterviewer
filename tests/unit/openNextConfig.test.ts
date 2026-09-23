// @vitest-environment node
// The OpenNext configuration differs from the adapter's own only by the
// backpressure wrapper (cloudflare/opennext/backpressureWrapper.ts). The
// adapter's name-based validation has to be disabled for that override, so
// this test restores it for every other field and pins the upstream wrapper
// the override was copied from.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import config from '../../open-next.config';

const UPSTREAM_WRAPPER = path.resolve(__dirname, '../../node_modules/@opennextjs/aws/dist/overrides/wrappers/cloudflare-node.js');
const UPSTREAM_WRAPPER_SHA256 = '6a5521bf7978d433b92827e1a472468a7187cfc334f29930e4672d21a5b79a17';

function withoutFunctions(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, entry) => (typeof entry === 'function' ? '[function]' : entry)));
}

describe('open-next.config.ts', () => {
  it('equals the adapter default except for the server wrapper, its node:stream external and the disabled name check', () => {
    const expected = defineCloudflareConfig({});
    expect(expected.default.override?.wrapper).toBe('cloudflare-node');
    const actual = withoutFunctions({
      ...config,
      default: { ...config.default, override: { ...config.default.override, wrapper: 'cloudflare-node' } },
      cloudflare: { ...config.cloudflare, dangerousDisableConfigValidation: undefined },
      edgeExternals: config.edgeExternals?.filter((name) => name !== 'node:stream'),
    });
    expect(actual).toEqual(withoutFunctions(expected));
    expect(config.cloudflare?.dangerousDisableConfigValidation).toBe(true);
    expect(config.edgeExternals).toContain('node:stream');
    expect(config.middleware && 'override' in config.middleware ? config.middleware.override?.wrapper : undefined).toBe('cloudflare-edge');
  });

  it('resolves the server wrapper to the backpressure copy', async () => {
    const wrapper = config.default.override?.wrapper;
    expect(typeof wrapper).toBe('function');
    const resolved = await (wrapper as () => Promise<{ name: string; supportStreaming: boolean; wrapper: unknown }>)();
    expect(resolved).toMatchObject({ name: 'cloudflare-node-backpressure', supportStreaming: true });
    expect(typeof resolved.wrapper).toBe('function');
  });

  it('pins the upstream cloudflare-node wrapper the override copies (re-sync it on an adapter upgrade)', () => {
    const digest = createHash('sha256').update(readFileSync(UPSTREAM_WRAPPER)).digest('hex');
    expect(digest).toBe(UPSTREAM_WRAPPER_SHA256);
  });
});
