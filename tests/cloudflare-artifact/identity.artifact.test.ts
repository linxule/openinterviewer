// RT-07 admission identity through the built Worker: cloudflare/worker.ts
// derives the identity from CF-Connecting-IP only and carries it in
// AsyncLocalStorage through OpenNext and Next's request handling to
// POST /api/auth, whose durable sign-in budget (10 failures per client key per
// 15 minutes, 200 across all clients per hour) makes the key observable: an
// exhausted key answers 429 before the password is compared, a fresh key 401.
//
// Local limit: miniflare's entry worker sets CF-Connecting-IP from the socket
// peer when a request carries none, as Cloudflare's edge does, so a request
// without the header never reaches the Worker here. The missing-header case is
// covered in tests/unit/runtime.clientAddress.test.ts and
// tests/unit/rateLimit.admissionIdentity.test.ts; this file covers invalid values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startArtifact, SYNTHETIC_SECRETS, type ArtifactHarness } from './harness';

const WRONG_PASSWORD = 'not-the-password-0000';
const CLIENT_LIMIT = 10;

let app: ArtifactHarness;

beforeAll(async () => {
  app = await startArtifact();
});

afterAll(async () => {
  await app?.close();
});

async function signIn(headers: Record<string, string>, password = WRONG_PASSWORD): Promise<Response> {
  const response = await fetch(new URL('/api/auth', app.url), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
  await response.arrayBuffer();
  return response;
}

async function statuses(requests: Array<Record<string, string>>): Promise<number[]> {
  const seen: number[] = [];
  for (const headers of requests) seen.push((await signIn(headers)).status);
  return seen;
}

/** Spends one client key's whole failure budget; every attempt must be a counted 401. */
async function exhaust(headers: Record<string, string>): Promise<void> {
  expect(await statuses(Array.from({ length: CLIENT_LIMIT }, () => headers))).toEqual(Array(CLIENT_LIMIT).fill(401));
}

const address = (value: string) => ({ 'cf-connecting-ip': value });

describe('RT-07 admission identity in the built Worker', () => {
  it('RT-07 each valid CF-Connecting-IP has its own sign-in budget; equivalent spellings share one', async () => {
    await exhaust(address('198.51.100.10'));
    const limited = await signIn(address('198.51.100.10'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Limited before the comparison: even the right password is refused.
    expect((await signIn(address('198.51.100.10'), SYNTHETIC_SECRETS.ADMIN_PASSWORD)).status).toBe(429);
    // The IPv4-mapped IPv6 spelling of the same client is the same key.
    expect((await signIn(address('::ffff:198.51.100.10'))).status).toBe(429);

    // Another address is untouched and can sign in.
    expect((await signIn(address('198.51.100.11'))).status).toBe(401);
    expect((await signIn(address('198.51.100.11'), SYNTHETIC_SECRETS.ADMIN_PASSWORD)).status).toBe(200);

    // IPv6: one budget per /64 (RT-07 owner amendment), whatever the spelling or interface.
    await exhaust(address('2001:db8:0:0:0:0:0:a'));
    expect((await signIn(address('2001:DB8::A'))).status).toBe(429);
    expect((await signIn(address('2001:db8::b'))).status).toBe(429);
    expect((await signIn(address('2001:db8:0:1::a'))).status).toBe(401);
  });

  it('RT-07 invalid CF-Connecting-IP values share the unknown bucket, and a forged internal header cannot leave it', async () => {
    // Surrounding whitespace is not among them: fetch strips it from header
    // values before they leave the client, so the Worker never sees it.
    const invalid = [
      'not-an-address',
      '198.51.100.20, 198.51.100.21',
      '198.51.100.20:443',
      '[2001:db8::20]',
      '198.51.100.256',
      'fe80::1%eth0',
      '2001:db8::g',
      '2001:db8::1::2',
      'localhost',
      '198.51.100',
    ];
    expect(await statuses(invalid.map(address))).toEqual(Array(CLIENT_LIMIT).fill(401));
    // A different invalid value lands in the same, now exhausted, bucket.
    expect((await signIn(address('999.1.1.1'))).status).toBe(429);
    // Claiming a fresh address through the reserved internal namespace or the
    // Node forwarding chain does not move an unknown client into it.
    expect((await signIn({
      ...address('198.51.100.20:443'),
      'x-openinterviewer-internal-client-address': '198.51.100.22',
      'x-openinterviewer-internal-identity': JSON.stringify({ kind: 'address', address: '198.51.100.22' }),
      'x-forwarded-for': '198.51.100.22',
      'x-real-ip': '198.51.100.22',
      'x-vercel-forwarded-for': '198.51.100.22',
    })).status).toBe(429);
    // The valid address inside those invalid values is its own key.
    expect((await signIn(address('198.51.100.20'))).status).toBe(401);
    expect((await signIn(address('198.51.100.22'))).status).toBe(401);
  });

  it('RT-07 forged internal or forwarding headers do not change a valid client\'s identity', async () => {
    const exhausted = '198.51.100.30';
    const fresh = '198.51.100.31';
    const claiming = (other: string) => ({
      'x-openinterviewer-internal-client-address': other,
      'x-openinterviewer-internal-identity': JSON.stringify({ kind: 'address', address: other }),
      'X-OpenInterviewer-Internal-Admission': other,
      'x-forwarded-for': other,
      'x-real-ip': other,
      'x-vercel-forwarded-for': other,
    });
    await exhaust(address(exhausted));
    // The exhausted client cannot borrow the fresh client's budget...
    expect((await signIn({ ...address(exhausted), ...claiming(fresh) })).status).toBe(429);
    // ...and the fresh client is not charged to, or limited by, the exhausted one.
    expect((await signIn({ ...address(fresh), ...claiming(exhausted) })).status).toBe(401);
    expect((await signIn({ ...address(fresh), ...claiming(exhausted) }, SYNTHETIC_SECRETS.ADMIN_PASSWORD)).status).toBe(200);
  });

  it('RT-07 a Workers subrequest (CF-Worker present) is its own scope, never the address it presents', async () => {
    await exhaust(address('198.51.100.40'));
    // Whatever address and CF-Worker value a subrequest presents, it spends one shared subrequest budget.
    const subrequests = Array.from({ length: CLIENT_LIMIT }, (_, index) => ({
      ...address(index === 0 ? '198.51.100.40' : `198.51.100.${41 + index}`),
      'cf-worker': `caller-${index}.example.workers.dev`,
    }));
    expect(await statuses(subrequests)).toEqual(Array(CLIENT_LIMIT).fill(401));
    expect((await signIn({ ...address('198.51.100.60'), 'cf-worker': 'another.example.workers.dev' })).status).toBe(429);
    // Neither the exhausted address nor the exhausted subrequest scope touched a direct client's budget.
    expect((await signIn(address('198.51.100.60'))).status).toBe(401);
    expect((await signIn(address('198.51.100.40'))).status).toBe(429);
  });

  it('VERIFY-01 made no outbound request', () => {
    expect(app.outbound).toEqual([]);
    expect(app.refused).toEqual([]);
  });
});
