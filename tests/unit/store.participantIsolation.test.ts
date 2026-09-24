import { describe, it, expect, beforeEach } from 'vitest';
import { migratedTransport, useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

/**
 * Participant session isolation contract.
 *
 * When a participant link is resolved, the participant session must start
 * clean: no interview history, profile, or consent from a
 * previous participant may leak into the new session.
 *
 * The participant page installs a fresh tab selector together with the study
 * config, so history and authority from an earlier link must both be replaced.
 */

const makeMessage = (id: string, content: string) => ({
  id,
  role: 'ai' as const,
  content,
  timestamp: Date.now(),
});

beforeEach(() => {
  sessionStorage.clear();
  useStore.setState(useStore.getInitialState(), true);
});

describe('participant session isolation', () => {
  it('clears prior participant history when a different session handle is installed', () => {
    const store = useStore.getState();

    // Participant A loads link A (sequence performed by /p/[token] page)
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'participant-handle-a-123456'
    );
    store.addMessage(makeMessage('m1', 'greeting from A'));

    expect(useStore.getState().interviewHistory).toHaveLength(1);

    // Participant B opens link B in the same tab
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-b', name: 'Study B' }),
      'participant-handle-b-123456'
    );

    // Contract: B's session must not inherit A's messages or profile data
    const after = useStore.getState();
    expect(after.interviewHistory).toEqual([]);
    expect(after.participantSessionHandle).toBe('participant-handle-b-123456');
    expect(after.viewMode).toBe('participant');
    expect(after.studyConfig?.name).toBe('Study B');
  });

  it('resetParticipant clears the session handle, history, profile and consent', () => {
    const store = useStore.getState();
    store.setStudyConfig(makeStudyConfig({ id: 'study-a', name: 'Study A' }));
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'participant-handle-a-123456'
    );
    store.addMessage(makeMessage('m1', 'hello'));
    store.giveConsent(1_700_000_000_000);
    store.initializeProfile(useStore.getState().studyConfig!.profileSchema);

    useStore.getState().resetParticipant();

    const after = useStore.getState();
    expect(after.participantSessionHandle).toBeNull();
    expect(after.interviewHistory).toEqual([]);
    expect(after.participantProfile).toBeNull();
    expect(after.consentGiven).toBe(false);
  });

  it('persists the non-secret session handle in tab-scoped session storage', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'participant-handle-a-123456'
    );

    const persisted = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(persisted.state.participantSessionHandle).toBe('participant-handle-a-123456');
    expect(persisted.state).not.toHaveProperty('participantToken');

    useStore.getState().resetParticipant();
    const reset = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(reset.state.participantSessionHandle).toBeNull();
  });

  it('removes a legacy browser-held participant token during hydration', async () => {
    sessionStorage.setItem('research-tool-storage', JSON.stringify({
      version: 3,
      state: {
        viewMode: 'participant',
        participantToken: 'legacy-browser-token',
        participantSessionHandle: 'participant-handle-a-123456',
      },
    }));

    await useStore.persist.rehydrate();

    expect(useStore.getState()).not.toHaveProperty('participantToken');
    expect(useStore.getState().participantSessionHandle).toBe('participant-handle-a-123456');
    const migrated = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(migrated.version).toBe(6);
    expect(migrated.state).not.toHaveProperty('participantToken');
    // Before v6 only direct and Vercel gateway existed: a missing value was direct.
    expect(migrated.state.aiTransport).toBe('direct');
  });

  it.each(['direct', 'gateway', 'cloudflare-gateway'] as const)('v6 migration keeps the known transport %s', async (transport) => {
    sessionStorage.setItem('research-tool-storage', JSON.stringify({
      version: 5,
      state: { viewMode: 'participant', aiTransport: transport, participantSessionHandle: 'participant-handle-a-123456' },
    }));

    await useStore.persist.rehydrate();

    expect(useStore.getState().aiTransport).toBe(transport);
  });

  it('the transport migration never turns an unknown value from v6 on into a transport', () => {
    expect(migratedTransport('carrier-pigeon', 6)).toBeNull();
    expect(migratedTransport(undefined, 6)).toBeNull();
    expect(migratedTransport('cloudflare-gateway', 6)).toBe('cloudflare-gateway');
    // A v5 client never wrote cloudflare-gateway; its unknown values meant direct.
    expect(migratedTransport('carrier-pigeon', 5)).toBe('direct');
  });

  it('keeps real participant and researcher preview modes distinct', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'participant-handle-a-123456'
    );
    expect(useStore.getState().viewMode).toBe('participant');

    useStore.getState().setViewMode('preview');
    expect(useStore.getState().viewMode).toBe('preview');
  });

  it('binds the participant view to the non-secret deployment transport disclosure', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-gateway', name: 'Gateway Study' }),
      'participant-handle-gateway-123456',
      'gateway',
    );

    expect(useStore.getState().aiTransport).toBe('gateway');
    const persisted = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(persisted.state.aiTransport).toBe('gateway');
  });
});
