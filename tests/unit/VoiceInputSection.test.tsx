import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VoiceInputSection } from '@/components/studySetup/VoiceInputSection';
import type { StudyDraft } from '@/components/studySetup/useStudyDraft';

describe('device voice setup', () => {
  it.each([true, false])('offers device mode without transcription capability (hosted=%s)', hosted => {
    const setVoiceInput = vi.fn();
    const draft = { voiceInput: 'off', setVoiceInput } as unknown as StudyDraft;
    render(<VoiceInputSection draft={draft} editing onEdit={vi.fn()} transcriptionAvailable={false} hosted={hosted} />);
    const device = screen.getByRole('radio', { name: /On the participant’s computer/ });
    expect(device).toBeEnabled();
    expect(screen.getByRole('radio', { name: /Transcribed by this installation/ })).toBeDisabled();
    fireEvent.click(device);
    expect(setVoiceInput).toHaveBeenCalledWith('device');
    expect(screen.getByText(/Participants on phones, Safari and Firefox/)).toHaveTextContent('says the audio stays there');
  });
});
