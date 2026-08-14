import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '@/store';
import { makeStudyConfig } from '../fixtures/models';

/**
 * Participant session isolation contract.
 *
 * When a participant link (token) is installed, the participant session must
 * start clean: no interview history, profile, consent, or token from a
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
  it('clears prior participant history when a different token is installed', () => {
    const store = useStore.getState();

    // Participant A loads link A (sequence performed by /p/[token] page)
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'token-a',
      'participant-handle-a-123456'
    );
    store.addMessage(makeMessage('m1', 'greeting from A'));

    expect(useStore.getState().interviewHistory).toHaveLength(1);

    // Participant B opens link B in the same tab
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-b', name: 'Study B' }),
      'token-b',
      'participant-handle-b-123456'
    );

    // Contract: B's session must not inherit A's messages or profile data
    const after = useStore.getState();
    expect(after.interviewHistory).toEqual([]);
    expect(after.participantToken).toBe('token-b');
    expect(after.participantSessionHandle).toBe('participant-handle-b-123456');
    expect(after.viewMode).toBe('participant');
    expect(after.studyConfig?.name).toBe('Study B');
  });

  it('resetParticipant clears token, history, profile and consent', () => {
    const store = useStore.getState();
    store.setStudyConfig(makeStudyConfig({ id: 'study-a', name: 'Study A' }));
    store.beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      'token-a',
      'participant-handle-a-123456'
    );
    store.addMessage(makeMessage('m1', 'hello'));
    store.giveConsent(1_700_000_000_000);
    store.initializeProfile(useStore.getState().studyConfig!.profileSchema);

    useStore.getState().resetParticipant();

    const after = useStore.getState();
    expect(after.participantToken).toBeNull();
    expect(after.participantSessionHandle).toBeNull();
    expect(after.interviewHistory).toEqual([]);
    expect(after.participantProfile).toBeNull();
    expect(after.consentGiven).toBe(false);
  });

  it('persists the non-secret session handle in tab-scoped session storage', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      null,
      'participant-handle-a-123456'
    );

    const persisted = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(persisted.state.participantSessionHandle).toBe('participant-handle-a-123456');
    expect(persisted.state.participantToken).toBeNull();

    useStore.getState().resetParticipant();
    const reset = JSON.parse(sessionStorage.getItem('research-tool-storage') || '{}');
    expect(reset.state.participantSessionHandle).toBeNull();
  });

  it('keeps real participant and researcher preview modes distinct', () => {
    useStore.getState().beginParticipantSession(
      makeStudyConfig({ id: 'study-a', name: 'Study A' }),
      null,
      'participant-handle-a-123456'
    );
    expect(useStore.getState().viewMode).toBe('participant');

    useStore.getState().setViewMode('preview');
    expect(useStore.getState().viewMode).toBe('preview');
  });
});
