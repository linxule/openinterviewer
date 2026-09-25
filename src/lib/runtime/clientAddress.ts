// Client admission identity (RT-07).
//
// Cloudflare: the custom Worker entrypoint derives the identity from the
// validated CF-Connecting-IP header only and carries it in the invocation
// context. Route code never re-reads forwarding headers on this target.
// Node: the existing header chain (x-vercel-forwarded-for, x-forwarded-for,
// x-real-ip, first element) is preserved unchanged behind its own adapter.

import type { AdmissionIdentity } from './workerInvocation';

const IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function normalizeIpv4(value: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
  }
  return parts.map((part) => String(Number(part))).join('.');
}

function parseIpv6Groups(value: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return null;
  const doubleColon = value.indexOf('::');
  if (doubleColon !== value.lastIndexOf('::')) return null;

  // An embedded IPv4 suffix is valid only at the very end of the address.
  const parseSide = (side: string, allowIpv4Suffix: boolean): number[] | null => {
    if (side === '') return [];
    const pieces = side.split(':');
    const groups: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes('.')) {
        if (!allowIpv4Suffix || index !== pieces.length - 1) return null;
        const v4 = normalizeIpv4(piece);
        if (!v4) return null;
        const [a, b, c, d] = v4.split('.').map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  if (doubleColon === -1) {
    const groups = parseSide(value, true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseSide(value.slice(0, doubleColon), false);
  const tail = parseSide(value.slice(doubleColon + 2), true);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Canonical form of one client address, or null when the value is not exactly
 * one IPv4/IPv6 address. Lists, ports, brackets, zone suffixes, whitespace and
 * hostnames are rejected. IPv4-mapped IPv6 collapses to dotted IPv4 so the
 * same client cannot occupy two budget buckets.
 */
export function normalizeClientAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 64 || raw !== raw.trim()) return null;
  if (raw.includes('.') && !raw.includes(':')) return normalizeIpv4(raw);
  if (!raw.includes(':')) return null;
  const groups = parseIpv6Groups(raw);
  if (!groups) return null;
  const isV4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isV4Mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return groups.map((group) => group.toString(16).padStart(4, '0')).join(':');
}

type HeaderSource = { get(name: string): string | null };

/** Identity at the Cloudflare ingress boundary (called by the Worker entrypoint). */
export function cloudflareAdmissionIdentity(headers: HeaderSource): AdmissionIdentity {
  // Workers subrequests carry CF-Worker. Its value is caller-influenced and is
  // never a budget key; its presence alone is a conservative refusal signal.
  if (headers.get('cf-worker') !== null) return { kind: 'subrequest' };
  const raw = headers.get('cf-connecting-ip');
  if (raw === null || raw === '') return { kind: 'unknown', reason: 'missing' };
  const address = normalizeClientAddress(raw);
  return address ? { kind: 'address', address } : { kind: 'unknown', reason: 'invalid' };
}

/** The existing Node/Vercel header chain, preserved byte-for-byte. */
export function nodeForwardedAddress(headers: HeaderSource): string {
  const forwarded = headers.get('x-vercel-forwarded-for')
    || headers.get('x-forwarded-for')
    || headers.get('x-real-ip')
    || 'unknown';
  return forwarded.split(',')[0].trim() || 'unknown';
}

/**
 * The Node header chain's first address as an admission identity, normalized
 * like CF-Connecting-IP. Used only by the Node sign-in budget; participant
 * limits on Node keep the raw nodeForwardedAddress value.
 */
export function nodeAdmissionIdentity(headers: HeaderSource): AdmissionIdentity {
  const raw = nodeForwardedAddress(headers);
  if (raw === 'unknown') return { kind: 'unknown', reason: 'missing' };
  const address = normalizeClientAddress(raw);
  return address ? { kind: 'address', address } : { kind: 'unknown', reason: 'invalid' };
}

/**
 * The researcher sign-in budget's client subject (both standalone targets).
 * IPv4, including IPv4-mapped IPv6, is the full address. IPv6 is its /64, the
 * first four groups of the full form (owner amendment to RT-07, 25 September
 * 2026): one host commonly holds a whole /64, so a per-address key would give
 * it a fresh window for every address it rotates through. The `address64:`
 * tag keeps /64 subjects apart from every IPv4 subject. Requests without a
 * usable address share one `unknown` subject and Workers subrequests one
 * `subrequest` subject.
 */
export function signInBudgetSubject(identity: AdmissionIdentity | null): string {
  if (identity?.kind === 'subrequest') return 'subrequest';
  if (identity?.kind !== 'address') return 'unknown';
  const address = normalizeClientAddress(identity.address);
  if (address === null) return 'unknown';
  if (!address.includes(':')) return `address:${address}`;
  return `address64:${address.split(':').slice(0, 4).join(':')}`;
}
