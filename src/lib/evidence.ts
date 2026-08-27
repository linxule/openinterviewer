// The evidence matcher. Checks a synthesis's citation claims against the
// transcript that produced them.
//
// Pure and dependency-free: no I/O, no logging, and it never throws — a
// malformed ref is *classified* as unverified, never a render crash on a
// real record. Runs at render time, from the record, every time (A5.4); its
// verdict is never stored.

import { EvidenceRef, InterviewMessage, SynthesisTheme } from '@/types';

const MIN_QUOTE_CHARS = 4;
const MAX_QUOTE_SEGMENTS = 6;

export interface EvidenceSpan {
  start: number;
  end: number;
}

export type EvidenceMatch =
  | { status: 'verified'; turnIndex: number; spans: EvidenceSpan[]; occurrences: number }
  | { status: 'unverified'; reason: UnverifiedReason };

export type UnverifiedReason =
  | 'empty-quote'      // nothing left after normalization
  | 'too-short'        // fewer than MIN_QUOTE_CHARS normalized characters
  | 'no-turn'          // turnIndex out of range for this transcript
  | 'wrong-speaker'    // the cited turn is not a participant turn
  | 'not-found';       // the quote is not in the cited turn

// ============================================
// Normalization
// ============================================

interface ClusterRange {
  start: number;
  end: number;
}

interface NormalizedText {
  normalized: string;
  // map[i] is the source range that produced normalized[i].
  map: ClusterRange[];
}

const CURLY_SINGLE_CODES = [0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x2035];
const CURLY_DOUBLE_CODES = [0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x2036, 0x00ab, 0x00bb];
const DASH_CODES = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212];
const ELLIPSIS_CODE = 0x2026;
const ZERO_WIDTH_CODES = [0x200b, 0x200c, 0x200d, 0xfeff];

function foldCodePoint(codePoint: number): string {
  if (CURLY_SINGLE_CODES.includes(codePoint)) return "'";
  if (CURLY_DOUBLE_CODES.includes(codePoint)) return '"';
  if (DASH_CODES.includes(codePoint)) return '-';
  if (codePoint === ELLIPSIS_CODE) return '...';
  if (ZERO_WIDTH_CODES.includes(codePoint)) return '';
  return String.fromCodePoint(codePoint);
}

function foldCluster(cluster: string): string {
  const nfkc = cluster.normalize('NFKC');
  let out = '';
  for (const ch of nfkc) {
    out += foldCodePoint(ch.codePointAt(0) ?? 0);
  }
  return out;
}

function segmentGraphemes(text: string): string[] {
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: string }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor('en', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  // Fallback: walk code points and attach combining marks to their base.
  const clusters: string[] = [];
  for (const cp of text) {
    const codePoint = cp.codePointAt(0) ?? 0;
    const isCombining = codePoint >= 0x0300 && codePoint <= 0x036f;
    if (isCombining && clusters.length > 0) {
      clusters[clusters.length - 1] += cp;
    } else {
      clusters.push(cp);
    }
  }
  return clusters;
}

function isWhitespaceChar(ch: string): boolean {
  // JS `\s` already covers NBSP (U+00A0).
  return /\s/.test(ch);
}

/**
 * Builds a normalized string alongside a parallel array mapping each
 * normalized character back to its index range in the original source.
 * NFKC is applied per grapheme cluster (not per code unit) so a decomposed
 * base + combining mark can compose with a precomposed form on the other
 * side of the comparison. See A5.1.
 */
function normalizeForMatch(text: string): NormalizedText {
  const clusters = segmentGraphemes(text);

  // Step 1-5: fold each cluster (NFKC, quotes, dashes, ellipsis, zero-width),
  // keeping a per-character map back to the source cluster's range.
  let folded = '';
  const foldedMap: ClusterRange[] = [];
  let sourceIndex = 0;
  for (const cluster of clusters) {
    const clusterStart = sourceIndex;
    const clusterEnd = sourceIndex + cluster.length;
    sourceIndex = clusterEnd;

    const out = foldCluster(cluster);
    for (const ch of out) {
      folded += ch;
      foldedMap.push({ start: clusterStart, end: clusterEnd });
    }
  }

  // Step 6: collapse whitespace runs to a single space, trim ends.
  // Step 7: case fold.
  let collapsed = '';
  const collapsedMap: ClusterRange[] = [];
  let pendingSpace = false;
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i];
    if (isWhitespaceChar(ch)) {
      if (collapsed.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      collapsed += ' ';
      collapsedMap.push(foldedMap[i]);
      pendingSpace = false;
    }
    collapsed += ch.toLowerCase();
    collapsedMap.push(foldedMap[i]);
  }

  return { normalized: collapsed, map: collapsedMap };
}

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
];

/**
 * Strips a single balanced pair of wrapping quotation marks (ASCII or curly,
 * straight-double, single, or guillemet) and any leading/trailing ellipsis
 * from a raw quote string, before normalization. Applied to the quote only,
 * never the haystack.
 */
const ELLIPSIS_LEAD = /^(\.\.\.|…)\s*/;
const ELLIPSIS_TRAIL = /\s*(\.\.\.|…)$/;

function stripQuoteWrapping(text: string): string {
  let out = text.trim();

  // The ellipsis and the quote marks can wrap in either order (a model may
  // hand back `"…like this."` or `…"like this."`), so peel one layer of
  // either kind at a time until nothing more strips.
  for (let pass = 0; pass < 4; pass++) {
    const before = out;

    out = out.replace(ELLIPSIS_LEAD, '').replace(ELLIPSIS_TRAIL, '').trim();

    for (const [open, close] of QUOTE_PAIRS) {
      if (out.length >= open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        break;
      }
    }

    if (out === before) break;
  }

  return out;
}

// ============================================
// Matching
// ============================================

function splitSegments(normalizedQuote: string): string[] {
  return normalizedQuote
    .split('...')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function locateQuote(quote: string, turnContent: string): EvidenceSpan[] | UnverifiedReason {
  const strippedQuote = stripQuoteWrapping(quote);
  const { normalized: haystack, map: haystackMap } = normalizeForMatch(turnContent);
  const { normalized: needleFull } = normalizeForMatch(strippedQuote);

  if (needleFull.length === 0) return 'empty-quote';
  if (needleFull.length < MIN_QUOTE_CHARS) return 'too-short';

  const segments = splitSegments(needleFull);
  if (segments.length === 0) return 'empty-quote';
  // More than MAX_QUOTE_SEGMENTS ellipsis segments is not a quotation, it is a
  // collage (A5.2 step 3): refuse it rather than silently verifying a prefix.
  if (segments.length > MAX_QUOTE_SEGMENTS) return 'not-found';

  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const idx = haystack.indexOf(segment, cursor);
    if (idx === -1) return 'not-found';
    const normStart = idx;
    const normEnd = idx + segment.length;
    spans.push({
      start: haystackMap[normStart].start,
      end: haystackMap[normEnd - 1].end,
    });
    cursor = normEnd;
  }

  return spans;
}

function countOccurrences(quote: string, turnContent: string): number {
  const strippedQuote = stripQuoteWrapping(quote);
  const { normalized: haystack } = normalizeForMatch(turnContent);
  const { normalized: needleFull } = normalizeForMatch(strippedQuote);
  const firstSegment = splitSegments(needleFull)[0];
  if (!firstSegment) return 0;

  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(firstSegment, from);
    if (idx === -1) break;
    count += 1;
    from = idx + firstSegment.length;
  }
  return count;
}

/**
 * Resolves a single citation against a transcript. Never throws.
 */
export function resolveEvidenceRef(ref: EvidenceRef, transcript: InterviewMessage[]): EvidenceMatch {
  const turnIndex = ref?.turnIndex;
  if (
    typeof turnIndex !== 'number'
    || !Number.isInteger(turnIndex)
    || turnIndex < 1
    || turnIndex > transcript.length
  ) {
    return { status: 'unverified', reason: 'no-turn' };
  }

  const turn = transcript[turnIndex - 1];
  if (!turn || turn.role !== 'user') {
    return { status: 'unverified', reason: 'wrong-speaker' };
  }

  const quote = typeof ref?.quote === 'string' ? ref.quote : '';
  const located = locateQuote(quote, turn.content ?? '');
  if (typeof located === 'string') {
    return { status: 'unverified', reason: located };
  }

  return {
    status: 'verified',
    turnIndex,
    spans: located,
    occurrences: countOccurrences(quote, turn.content ?? ''),
  };
}

export type ThemeEvidenceView =
  | { kind: 'legacy'; text: string }
  | { kind: 'refs'; entries: { ref: EvidenceRef; match: EvidenceMatch; quotedFromRecord: string | null }[] }
  | { kind: 'none' };

/**
 * Resolves an entire theme's evidence against a transcript. Never throws.
 */
export function resolveThemeEvidence(theme: SynthesisTheme, transcript: InterviewMessage[]): ThemeEvidenceView {
  if (theme?.evidence !== undefined) {
    return { kind: 'legacy', text: theme.evidence };
  }

  const refs = Array.isArray(theme?.evidenceRefs) ? theme.evidenceRefs : [];
  if (refs.length === 0) {
    return { kind: 'none' };
  }

  const entries = refs.map((ref) => {
    const match = resolveEvidenceRef(ref, transcript);
    if (match.status !== 'verified') {
      return { ref, match, quotedFromRecord: null };
    }
    const turn = transcript[ref.turnIndex - 1];
    const quotedFromRecord = match.spans
      .map((span) => turn.content.slice(span.start, span.end))
      .join(' … ');
    return { ref, match, quotedFromRecord };
  });

  return { kind: 'refs', entries };
}
