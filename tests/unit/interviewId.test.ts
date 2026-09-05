import { describe, expect, it } from 'vitest';
import { shortInterviewId } from '@/lib/interviewId';

describe('shortInterviewId', () => {
  it('strips the session- prefix and returns the first eight characters', () => {
    const id = shortInterviewId('session-9f1c2b7a-0000-4000-8000-000000000000');
    expect(id).toBe('9f1c2b7a');
    expect(id).not.toContain('session-');
  });

  it('strips the interview- prefix and returns the remainder whole when short', () => {
    expect(shortInterviewId('interview-demo-sarah')).toBe('demo-sarah');
  });

  it('truncates an id with no known prefix to eight characters', () => {
    expect(shortInterviewId('abcdefghijklmnop')).toBe('abcdefgh');
  });

  it('returns a short id whole', () => {
    expect(shortInterviewId('abc123')).toBe('abc123');
  });
});
