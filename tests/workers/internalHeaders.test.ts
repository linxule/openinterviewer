// RT-07: the Worker entry strips the reserved x-openinterviewer-internal-*
// namespace before OpenNext sees a request. Runs the stripping in workerd,
// whose Headers the production entry uses. That the entry applies it is
// checked in tests/unit/cloudflareWorkerEntry.test.ts: the entry imports the
// generated OpenNext bundle, which an unbuilt tier cannot load or mock.
import { describe, expect, it } from 'vitest';
import { withoutInternalHeaders } from '../../cloudflare/internalHeaders';

const URL_WITH_QUERY = 'https://openinterviewer.example.workers.dev/api/auth?next=%2Fstudies';
const BODY = JSON.stringify({ password: 'synthetic-password-0123456789' });

function post(headers: Record<string, string>): Request {
  return new Request(URL_WITH_QUERY, { method: 'POST', headers, body: BODY });
}

describe('reserved internal headers (RT-07)', () => {
  it('RT-07 removes every x-openinterviewer-internal-* header, in any case, and keeps every other header, the method, URL and body', async () => {
    const stripped = withoutInternalHeaders(post({
      'X-OpenInterviewer-Internal-Identity': 'address:203.0.113.9',
      'x-openinterviewer-internal-source': 'queue',
      'X-OPENINTERVIEWER-INTERNAL-ENV': '{"DEPLOYMENT_TARGET":"node"}',
      'x-OpenInterviewer-internal-': 'empty suffix',
      'x-openinterviewer-internals': 'outside the namespace',
      'x-openinterviewer-participant-session': 'selector-1',
      'CF-Connecting-IP': '198.51.100.7',
      'Content-Type': 'application/json',
      Cookie: 'researcher-session=synthetic',
    }));

    expect(new Map(stripped.headers)).toEqual(new Map([
      ['x-openinterviewer-internals', 'outside the namespace'],
      ['x-openinterviewer-participant-session', 'selector-1'],
      ['cf-connecting-ip', '198.51.100.7'],
      ['content-type', 'application/json'],
      ['cookie', 'researcher-session=synthetic'],
    ]));
    expect(stripped.method).toBe('POST');
    expect(stripped.url).toBe(URL_WITH_QUERY);
    expect(await stripped.text()).toBe(BODY);
  });

  it('RT-07 leaves a request with no reserved header unchanged', async () => {
    const stripped = withoutInternalHeaders(post({ 'CF-Connecting-IP': '2001:db8::7', 'Content-Type': 'application/json' }));

    expect(new Map(stripped.headers)).toEqual(new Map([
      ['cf-connecting-ip', '2001:db8::7'],
      ['content-type', 'application/json'],
    ]));
    expect(stripped.method).toBe('POST');
    expect(await stripped.text()).toBe(BODY);
  });
});
