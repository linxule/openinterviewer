// @vitest-environment node
//
// RT-11 / SETUP-08: the installer (plain Node, scripts/cloudflare/installer)
// and the Worker (src/lib/providers/endpoint.ts) state the Cloudflare AI
// Gateway rules twice. These tests keep the two equal: the probe sends the
// Worker's exact cf-aig-* set to the Worker's only gateway host, and the
// installer accepts exactly the identifiers and tokens the Worker accepts.

import { describe, expect, it } from 'vitest';
import {
  GATEWAY_ORIGIN,
  gatewayRequestHeaders,
} from '../../scripts/cloudflare/installer/gateway.mjs';
import {
  ACCOUNT_ID_PATTERN,
  GATEWAY_ID_PATTERN,
  MIN_GATEWAY_TOKEN_LENGTH,
} from '../../scripts/cloudflare/installer/model.mjs';
import { transportProblems } from '../../scripts/cloudflare/installer/verify.mjs';
import { missingInstallationVars, transportVarProblems } from '../../scripts/cloudflare/deploy.mjs';
import {
  CF_AI_GATEWAY_ACCOUNT_ID_PATTERN,
  CF_AI_GATEWAY_ID_PATTERN,
  CF_AI_GATEWAY_ORIGIN,
  MIN_CF_AI_GATEWAY_TOKEN_LENGTH,
  cfAigRequestHeaders,
  providerRouteErrors,
} from '@/lib/providers/endpoint';

const TOKEN = 'synthetic-aig-run-token-0123456789abcdef';

describe('installer and Worker agree on the Cloudflare AI Gateway contract', () => {
  it('probes with exactly the headers the Worker sends, to the same host', () => {
    expect(gatewayRequestHeaders(TOKEN)).toEqual(cfAigRequestHeaders(TOKEN));
    const withoutAuthorization = { ...cfAigRequestHeaders(TOKEN) } as Record<string, string>;
    delete withoutAuthorization['cf-aig-authorization'];
    expect(gatewayRequestHeaders(null)).toEqual(withoutAuthorization);
    expect(GATEWAY_ORIGIN).toBe(CF_AI_GATEWAY_ORIGIN);
  });

  it('uses the same identifier patterns and token minimum', () => {
    expect(GATEWAY_ID_PATTERN.source).toBe(CF_AI_GATEWAY_ID_PATTERN.source);
    expect(ACCOUNT_ID_PATTERN.source).toBe(CF_AI_GATEWAY_ACCOUNT_ID_PATTERN.source);
    expect(MIN_GATEWAY_TOKEN_LENGTH).toBe(MIN_CF_AI_GATEWAY_TOKEN_LENGTH);
  });

  it('refuses in verify --config exactly the var sets whose route the Worker refuses', () => {
    const account = 'a'.repeat(32);
    const cases: Record<string, string>[] = [
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'default' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account.toUpperCase(), CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'Oi-Acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: `oi-${'a'.repeat(62)}` },
      { AI_TRANSPORT: 'gateway', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' },
    ];
    for (const vars of cases) {
      // The Run token is a secret the installer binds; the config holds only vars.
      const workerRefuses = providerRouteErrors({ ...vars, CF_AI_GATEWAY_TOKEN: TOKEN }).length > 0;
      expect(transportProblems(vars).length > 0, JSON.stringify(vars)).toBe(workerRefuses);
    }
  });

  it('refuses in deploy.mjs exactly the var sets whose route the Worker refuses, before upload', () => {
    const account = 'a'.repeat(32);
    const base = { APP_BASE_URL: 'https://interviews.example.org', WORKSPACE_ID: `ws_${'b'.repeat(32)}`, AI_PROVIDER: 'gemini' };
    // JSON wrangler vars may also hold numbers and booleans.
    const cases: Record<string, unknown>[] = [
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 12345 },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: true },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: 123, CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: 0, CF_AI_GATEWAY_ID: false },
      {},
      { AI_TRANSPORT: '' },
      { AI_TRANSPORT: '', CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: 'direct', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: ' direct ', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: ' cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: ' cloudflare-gateway ', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: '' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'default' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: ` ${account}`, CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: 'oi-acme ' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account.toUpperCase(), CF_AI_GATEWAY_ID: 'oi-acme' },
      { AI_TRANSPORT: 'cloudflare-gateway', CF_AI_GATEWAY_ACCOUNT_ID: account, CF_AI_GATEWAY_ID: `oi-${'a'.repeat(62)}` },
      { AI_TRANSPORT: 'gateway', CF_AI_GATEWAY_ACCOUNT_ID: '', CF_AI_GATEWAY_ID: '' },
    ];
    for (const vars of cases) {
      const workerRefuses = providerRouteErrors({ ...vars, CF_AI_GATEWAY_TOKEN: TOKEN } as Record<string, string>).length > 0;
      const all = { ...base, ...vars };
      const deployRefuses = missingInstallationVars(all).length > 0 || transportVarProblems(all).length > 0;
      expect(deployRefuses, JSON.stringify(vars)).toBe(workerRefuses);
    }
  });
});
