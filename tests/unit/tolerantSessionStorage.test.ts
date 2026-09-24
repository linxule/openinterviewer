import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tolerantStorage } from '@/lib/tolerantSessionStorage';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

// jsdom's Storage, not the Node global of the same name.
const jsdomStorage = () => Object.getPrototypeOf(window.sessionStorage) as Storage;

const quotaExceeded = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
const denied = () => new DOMException('The operation is insecure.', 'SecurityError');

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: vi.fn((name: string) => items.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { items.set(name, value); }),
    removeItem: vi.fn((name: string) => { items.delete(name); }),
  };
}

describe('tolerant session storage', () => {
  it('passes reads and writes through while storage works', () => {
    const backing = memoryStorage();
    const storage = tolerantStorage(() => backing);
    storage.setItem('key', 'value');
    expect(storage.getItem('key')).toBe('value');
    storage.removeItem('key');
    expect(storage.getItem('key')).toBeNull();
  });

  it('treats unavailable storage as empty and never throws', () => {
    const storage = tolerantStorage(() => { throw denied(); });
    expect(storage.getItem('key')).toBeNull();
    expect(() => storage.setItem('key', 'value')).not.toThrow();
    expect(() => storage.removeItem('key')).not.toThrow();
  });

  it('removes the older entry when a write fails, so no stale copy remains', () => {
    const backing = memoryStorage();
    backing.items.set('key', 'older');
    backing.setItem.mockImplementationOnce(() => { throw quotaExceeded(); });
    const storage = tolerantStorage(() => backing);

    expect(() => storage.setItem('key', 'newer')).not.toThrow();
    expect(backing.items.has('key')).toBe(false);

    // A later write that fits persists again.
    storage.setItem('key', 'latest');
    expect(storage.getItem('key')).toBe('latest');
  });

  it('does not throw when both the write and the clean-up fail', () => {
    const backing = memoryStorage();
    backing.setItem.mockImplementation(() => { throw quotaExceeded(); });
    backing.removeItem.mockImplementation(() => { throw denied(); });
    expect(() => tolerantStorage(() => backing).setItem('key', 'value')).not.toThrow();
  });

  it('never reads back an older snapshot that a failed write could not remove', () => {
    const backing = memoryStorage();
    const storage = tolerantStorage(() => backing);
    storage.setItem('key', 'older');
    backing.setItem.mockImplementationOnce(() => { throw quotaExceeded(); });
    backing.removeItem.mockImplementationOnce(() => { throw denied(); });
    storage.setItem('key', 'newer');
    expect(backing.items.get('key')).toBe('older');
    expect(storage.getItem('key')).toBeNull();

    // A later write that fits is read back again.
    storage.setItem('key', 'latest');
    expect(storage.getItem('key')).toBe('latest');
  });
});

describe('persisted store when sessionStorage writes fail (issue #52)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useStore.setState(useStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps every update in memory instead of throwing out of it', () => {
    vi.spyOn(jsdomStorage(), 'setItem').mockImplementation(() => { throw quotaExceeded(); });
    const store = useStore.getState();

    expect(() => store.beginParticipantSession(makeStudyConfig({ id: 'study-quota' }), 'handle-quota', 'direct')).not.toThrow();
    expect(() => store.addMessage({ id: 'm1', role: 'ai', content: 'Hello', timestamp: 1 })).not.toThrow();
    expect(() => store.giveConsent(1_700_000_000_000)).not.toThrow();

    expect(useStore.getState()).toMatchObject({
      participantSessionHandle: 'handle-quota',
      consentGiven: true,
      studyConfig: expect.objectContaining({ id: 'study-quota' }),
    });
    expect(useStore.getState().interviewHistory).toHaveLength(1);
    expect(sessionStorage.getItem('research-tool-storage')).toBeNull();
  });

  it('keeps working in memory when sessionStorage access itself throws', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw denied(); });

    expect(() => useStore.getState().beginParticipantSession(makeStudyConfig({ id: 'study-denied' }), 'handle-denied')).not.toThrow();
    expect(useStore.getState().participantSessionHandle).toBe('handle-denied');
  });

  it('hydrates nothing, without throwing, when the persisted entry cannot be read', async () => {
    vi.spyOn(jsdomStorage(), 'getItem').mockImplementation(() => { throw denied(); });

    await expect(Promise.resolve(useStore.persist.rehydrate())).resolves.toBeUndefined();
    expect(useStore.getState().studyConfig).toBeNull();
  });
});
