// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  cloudflareAdmissionIdentity,
  nodeAdmissionIdentity,
  nodeForwardedAddress,
  normalizeClientAddress,
  signInBudgetSubject,
} from '@/lib/runtime/clientAddress';

const V6_DOC = '2001:0db8:0000:0000:0000:0000:0000:0001';

describe('RT-07 client address normalization', () => {
  it('RT-07 keeps canonical dotted-quad IPv4', () => {
    expect(normalizeClientAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientAddress('0.0.0.0')).toBe('0.0.0.0');
    expect(normalizeClientAddress('255.255.255.255')).toBe('255.255.255.255');
  });

  // Policy: an octet with a leading zero is rejected rather than reinterpreted.
  // Some parsers read it as octal, so accepting it would let one spelling map
  // to two different addresses depending on the reader.
  it.each(['203.000.113.7', '01.2.3.4', '1.2.3.04', '00.0.0.0'])(
    'RT-07 rejects the leading-zero IPv4 spelling %j',
    (value) => {
      expect(normalizeClientAddress(value)).toBeNull();
    },
  );

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.', '.1.2.3', '1..2.3', '-1.2.3.4', '1.2.3.4a'])(
    'RT-07 rejects the malformed IPv4 %j',
    (value) => {
      expect(normalizeClientAddress(value)).toBeNull();
    },
  );

  it('RT-07 collapses equivalent IPv6 spellings to one full lowercase form', () => {
    for (const spelling of [
      '2001:db8::1',
      '2001:DB8::1',
      '2001:db8:0:0:0:0:0:1',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
      '2001:db8:0::0:1',
      '2001:db8::0:0:1',
    ]) {
      expect(normalizeClientAddress(spelling)).toBe(V6_DOC);
    }
    expect(normalizeClientAddress('::')).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    expect(normalizeClientAddress('::1')).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(normalizeClientAddress('1:2:3:4:5:6:7::')).toBe('0001:0002:0003:0004:0005:0006:0007:0000');
  });

  it('RT-07 collapses IPv4-mapped IPv6 to the IPv4 bucket', () => {
    for (const spelling of [
      '::ffff:203.0.113.7',
      '::FFFF:203.0.113.7',
      '::ffff:cb00:7107',
      '0:0:0:0:0:ffff:203.0.113.7',
      '0000:0000:0000:0000:0000:ffff:cb00:7107',
    ]) {
      expect(normalizeClientAddress(spelling)).toBe('203.0.113.7');
    }
  });

  it.each([
    ['address list', '203.0.113.7, 198.51.100.1'],
    ['address list without space', '203.0.113.7,198.51.100.1'],
    ['IPv4 with port', '203.0.113.7:443'],
    ['bracketed IPv6', '[2001:db8::1]'],
    ['bracketed IPv6 with port', '[2001:db8::1]:443'],
    ['zone id', 'fe80::1%eth0'],
    ['numeric zone id', 'fe80::1%1'],
    ['leading whitespace', ' 203.0.113.7'],
    ['trailing newline', '203.0.113.7\n'],
    ['inner whitespace', '2001:db8:: 1'],
    ['hostname', 'client.example.com'],
    ['bare hostname', 'localhost'],
    ['empty', ''],
    ['two double colons', '1::2::3'],
    ['triple colon', '1:::2'],
    ['nine groups', '1:2:3:4:5:6:7:8:9'],
    ['seven groups', '1:2:3:4:5:6:7'],
    ['double colon replacing nothing', '1:2:3:4:5:6:7:8::'],
    ['oversized group', '12345::1'],
    ['non-hex group', 'gggg::1'],
    ['leading single colon', ':1:2:3:4:5:6:7'],
    ['trailing single colon', '1:2:3:4:5:6:7:'],
    ['IPv4 suffix before the double colon', '1.2.3.4::'],
    ['IPv4 in the middle', '1:2:3:4:1.2.3.4:5:6'],
    ['IPv4 suffix with leading zero', '::ffff:203.0.113.07'],
    ['over-long value', `${'0:'.repeat(40)}1`],
  ])('RT-07 rejects %s', (_label, value) => {
    expect(normalizeClientAddress(value)).toBeNull();
  });

  it('RT-07 rejects non-string input', () => {
    expect(normalizeClientAddress(null)).toBeNull();
    expect(normalizeClientAddress(undefined)).toBeNull();
  });
});

describe('RT-07 Cloudflare admission identity', () => {
  it('RT-07 uses only the normalized CF-Connecting-IP', () => {
    expect(cloudflareAdmissionIdentity(new Headers({ 'cf-connecting-ip': '2001:DB8::1' }))).toEqual({
      kind: 'address',
      address: V6_DOC,
    });
    expect(cloudflareAdmissionIdentity(new Headers({
      'cf-connecting-ip': '::ffff:203.0.113.7',
      'x-forwarded-for': '198.51.100.1',
      'x-vercel-forwarded-for': '198.51.100.2',
      'x-real-ip': '198.51.100.3',
    }))).toEqual({ kind: 'address', address: '203.0.113.7' });
  });

  it('RT-07 never falls back to forwarding headers when CF-Connecting-IP is absent', () => {
    expect(cloudflareAdmissionIdentity(new Headers({
      'x-forwarded-for': '198.51.100.1',
      'x-vercel-forwarded-for': '198.51.100.2',
      'x-real-ip': '198.51.100.3',
    }))).toEqual({ kind: 'unknown', reason: 'missing' });
    expect(cloudflareAdmissionIdentity(new Headers())).toEqual({ kind: 'unknown', reason: 'missing' });
    expect(cloudflareAdmissionIdentity(new Headers({ 'cf-connecting-ip': '' })))
      .toEqual({ kind: 'unknown', reason: 'missing' });
  });

  it('RT-07 classifies malformed CF-Connecting-IP values as invalid', () => {
    for (const value of ['203.0.113.7, 198.51.100.1', '203.0.113.7:443', '[::1]', 'fe80::1%eth0', 'client.example']) {
      expect(cloudflareAdmissionIdentity(new Headers({ 'cf-connecting-ip': value })))
        .toEqual({ kind: 'unknown', reason: 'invalid' });
    }
  });

  it('RT-07 marks any CF-Worker subrequest regardless of its value or a valid address', () => {
    expect(cloudflareAdmissionIdentity(new Headers({
      'cf-worker': 'attacker.example',
      'cf-connecting-ip': '203.0.113.7',
    }))).toEqual({ kind: 'subrequest' });
    expect(cloudflareAdmissionIdentity(new Headers({ 'cf-worker': '' }))).toEqual({ kind: 'subrequest' });
  });
});

describe('RT-07 Node forwarded chain', () => {
  it('RT-07 preserves the existing Vercel/XFF/x-real-ip order and first-element rule', () => {
    expect(nodeForwardedAddress(new Headers({
      'x-vercel-forwarded-for': '203.0.113.1, 10.0.0.1',
      'x-forwarded-for': '198.51.100.1',
      'x-real-ip': '198.51.100.2',
    }))).toBe('203.0.113.1');
    expect(nodeForwardedAddress(new Headers({
      'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1',
      'x-real-ip': '198.51.100.2',
    }))).toBe('198.51.100.1');
    expect(nodeForwardedAddress(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(nodeForwardedAddress(new Headers())).toBe('unknown');
    expect(nodeForwardedAddress(new Headers({ 'x-forwarded-for': ' , 10.0.0.1' }))).toBe('unknown');
  });

  it('RT-07 does not normalize Node addresses or consult CF-Connecting-IP', () => {
    expect(nodeForwardedAddress(new Headers({
      'x-forwarded-for': '2001:DB8::1',
      'cf-connecting-ip': '203.0.113.7',
    }))).toBe('2001:DB8::1');
    expect(nodeForwardedAddress(new Headers({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('unknown');
  });
});

describe('F5 Node sign-in admission identity', () => {
  it('F5 normalizes the first address of the existing header chain', () => {
    expect(nodeAdmissionIdentity(new Headers({ 'x-forwarded-for': '2001:DB8::1, 10.0.0.1' })))
      .toEqual({ kind: 'address', address: V6_DOC });
    expect(nodeAdmissionIdentity(new Headers({
      'x-vercel-forwarded-for': '::ffff:203.0.113.7',
      'x-forwarded-for': '198.51.100.1',
    }))).toEqual({ kind: 'address', address: '203.0.113.7' });
    expect(nodeAdmissionIdentity(new Headers({ 'cf-connecting-ip': '203.0.113.7' })))
      .toEqual({ kind: 'unknown', reason: 'missing' });
    expect(nodeAdmissionIdentity(new Headers({ 'x-real-ip': 'client.example' })))
      .toEqual({ kind: 'unknown', reason: 'invalid' });
    expect(nodeAdmissionIdentity(new Headers({ 'x-forwarded-for': '203.0.113.7:443' })))
      .toEqual({ kind: 'unknown', reason: 'invalid' });
  });
});

describe('F5 sign-in budget subject (RT-07 owner amendment: IPv6 by /64)', () => {
  const subject = (address: string) => signInBudgetSubject({ kind: 'address', address });

  it('F5 keys IPv4 and IPv4-mapped IPv6 by the full address', () => {
    expect(subject('203.0.113.7')).toBe('address:203.0.113.7');
    expect(subject('::ffff:203.0.113.7')).toBe('address:203.0.113.7');
    expect(subject('203.0.113.8')).not.toBe(subject('203.0.113.7'));
  });

  it('F5 keys IPv6 by its /64: the first four groups of the full form', () => {
    expect(subject('2001:db8:0:1::1')).toBe('address64:2001:0db8:0000:0001');
    for (const sameSubnet of ['2001:DB8:0:1::2', '2001:db8:0:1:ffff:ffff:ffff:ffff', '2001:0db8:0000:0001:1234:5678:9abc:def0']) {
      expect(subject(sameSubnet)).toBe('address64:2001:0db8:0000:0001');
    }
    expect(subject('2001:db8:0:2::1')).toBe('address64:2001:0db8:0000:0002');
    expect(subject('::1')).toBe('address64:0000:0000:0000:0000');
    // A mapped-looking address outside ::ffff:0:0/96 is an ordinary IPv6 /64.
    expect(subject('::fffe:203.0.113.7')).toBe('address64:0000:0000:0000:0000');
  });

  it('F5 keeps the shared unknown and subrequest subjects', () => {
    expect(signInBudgetSubject(null)).toBe('unknown');
    expect(signInBudgetSubject({ kind: 'unknown', reason: 'missing' })).toBe('unknown');
    expect(signInBudgetSubject({ kind: 'unknown', reason: 'invalid' })).toBe('unknown');
    expect(subject('fe80::1%eth0')).toBe('unknown');
    expect(signInBudgetSubject({ kind: 'subrequest' })).toBe('subrequest');
  });
});
