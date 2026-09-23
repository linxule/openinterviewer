// Loaded with `node --import` into the setup.mjs process under test. It
// routes every fetch to the local fake origin server, preserving the
// requested origin in a header, so the installer's strict HTTPS origin rules
// stay untouched while no network request leaves the machine.

const base = process.env.FAKE_HTTP_BASE;
if (!base) throw new Error('FAKE_HTTP_BASE is not set');
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const requested = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const target = new URL(`${requested.pathname}${requested.search}`, base);
  const headers = new Headers(init.headers);
  headers.set('x-fake-origin', requested.origin);
  return realFetch(target, { ...init, headers });
};
