import { describe, expect, it } from 'vitest';
import {
  formatConsentTimestamp,
  formatElapsed,
  participantTurnCount,
  transcriptElapsedMs,
} from '@/lib/receiptFacts';

describe('participantTurnCount', () => {
  it('counts only role === "user", excluding ai and system', () => {
    const transcript = [
      { role: 'ai' },
      { role: 'user' },
      { role: 'system' },
      { role: 'user' },
      { role: 'ai' },
    ];
    expect(participantTurnCount(transcript)).toBe(2);
  });
});

describe('transcriptElapsedMs', () => {
  it('returns null for an empty transcript', () => {
    expect(transcriptElapsedMs([])).toBeNull();
  });

  it('returns null for a single message', () => {
    expect(transcriptElapsedMs([{ timestamp: 1000 }])).toBeNull();
  });

  it('returns the difference for two messages', () => {
    expect(transcriptElapsedMs([{ timestamp: 1000 }, { timestamp: 5000 }])).toBe(4000);
  });

  it('returns null for a negative difference', () => {
    expect(transcriptElapsedMs([{ timestamp: 5000 }, { timestamp: 1000 }])).toBeNull();
  });

  it('returns null for a non-finite timestamp', () => {
    expect(transcriptElapsedMs([{ timestamp: NaN }, { timestamp: 1000 }])).toBeNull();
    expect(transcriptElapsedMs([{ timestamp: 1000 }, { timestamp: Infinity }])).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('formats 0 as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('formats 34_000 as 0:34', () => {
    expect(formatElapsed(34_000)).toBe('0:34');
  });

  it('formats 252_000 as 4:12', () => {
    expect(formatElapsed(252_000)).toBe('4:12');
  });

  it('formats 3_912_000 as 1:05:12', () => {
    expect(formatElapsed(3_912_000)).toBe('1:05:12');
  });

  it('never contains the string "min"', () => {
    expect(formatElapsed(0)).not.toContain('min');
    expect(formatElapsed(34_000)).not.toContain('min');
    expect(formatElapsed(252_000)).not.toContain('min');
    expect(formatElapsed(3_912_000)).not.toContain('min');
  });
});

describe('formatConsentTimestamp', () => {
  it('formats a valid epoch millisecond as UTC', () => {
    expect(formatConsentTimestamp(1_700_000_000_000)).toBe('2023-11-14 22:13 UTC');
  });

  it('returns null for null', () => {
    expect(formatConsentTimestamp(null)).toBeNull();
  });

  it('returns null for 0', () => {
    expect(formatConsentTimestamp(0)).toBeNull();
  });

  it('returns null for -1', () => {
    expect(formatConsentTimestamp(-1)).toBeNull();
  });

  it('returns null for 1.5', () => {
    expect(formatConsentTimestamp(1.5)).toBeNull();
  });

  it('returns null for Number.MAX_SAFE_INTEGER + 2', () => {
    expect(formatConsentTimestamp(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});
