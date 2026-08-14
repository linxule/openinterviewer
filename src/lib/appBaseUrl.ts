// Canonical public origin for OAuth redirects and other absolute URLs.
// Production requires an explicit HTTPS APP_BASE_URL. Localhost is only
// a non-production fallback — never VERCEL_URL / preview host inference.

type BaseUrlEnv = {
  APP_BASE_URL?: string;
  NODE_ENV?: string;
};

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
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
  const configured = env.APP_BASE_URL?.trim();
  if (configured) {
    const url = parseAppBaseUrl(configured);
    if (!url) {
      throw new Error('APP_BASE_URL is invalid');
    }
    if (env.NODE_ENV === 'production') {
      if (url.protocol !== 'https:' || isLocalHostname(url.hostname)) {
        throw new Error('APP_BASE_URL must be a stable HTTPS origin in production');
      }
    }
    return formatAppBaseUrl(url);
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('APP_BASE_URL is required in production');
  }

  return 'http://localhost:3000';
}

export function isLocalAppHost(hostname: string): boolean {
  return isLocalHostname(hostname);
}
