// Canonical public origin for OAuth redirects and other absolute URLs.
// Production requires an explicit HTTPS APP_BASE_URL. Localhost is only
// a non-production fallback — never VERCEL_URL / preview host inference.
// The Cloudflare target is always production-strict (runtime NODE_ENV is not
// reliable inside a Worker).

import { normalizeClientAddress } from './runtime/clientAddress';
import { isProductionStrict } from './runtime/target';

type BaseUrlEnv = {
  APP_BASE_URL?: string;
  DEPLOYMENT_TARGET?: string;
  NODE_ENV?: string;
};

const IPV6_LOOPBACK = '0000:0000:0000:0000:0000:0000:0000:0001';

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // WHATWG URL serializes IPv6 hosts in brackets and IPv4 in dotted-quad form.
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const address = normalizeClientAddress(literal);
  if (!address) return false;
  return address === IPV6_LOOPBACK || address.startsWith('127.');
}

export function parseAppBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url;
  } catch {
    return null;
  }
}

export function formatAppBaseUrl(url: URL): string {
  return url.origin;
}

export function getAppBaseUrl(env: BaseUrlEnv = process.env): string {
  const strict = isProductionStrict(env);
  const configured = env.APP_BASE_URL?.trim();
  if (configured) {
    const url = parseAppBaseUrl(configured);
    if (!url) {
      throw new Error('APP_BASE_URL is invalid');
    }
    if (strict) {
      if (url.protocol !== 'https:' || isLocalHostname(url.hostname)) {
        throw new Error('APP_BASE_URL must be a stable HTTPS origin in production');
      }
    }
    return formatAppBaseUrl(url);
  }

  if (strict) {
    throw new Error('APP_BASE_URL is required in production');
  }

  return 'http://localhost:3000';
}

export function isLocalAppHost(hostname: string): boolean {
  return isLocalHostname(hostname);
}
