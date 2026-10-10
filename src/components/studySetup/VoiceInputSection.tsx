import type { VoiceInputMode } from '@/types';
import { Section } from './Section';
import type { StudyDraft } from './useStudyDraft';

export interface VoiceInputSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
  /** This installation can transcribe with Cloudflare Workers AI. */
  transcriptionAvailable: boolean;
  hosted: boolean;
}

const OPTIONS: { value: VoiceInputMode; label: string; detail: string }[] = [
  { value: 'off', label: 'Off', detail: 'Participants type their answers.' },
  {
    value: 'installation',
    label: 'Transcribed by this installation (Cloudflare Workers AI)',
    detail: 'Recordings of up to one minute go to Cloudflare, which already hosts the study, and are turned into text by Whisper. OpenInterviewer does not keep them; Cloudflare’s terms rule out training on them but state no retention period. Works in current browsers on phones and computers. Cloudflare bills about $0.0005 per audio minute after a free daily allowance.',
  },
  {
    value: 'device',
    label: 'On the participant’s computer (desktop Chrome only)',
    detail: 'Your participant’s browser turns speech into text on their computer and says the audio stays there; the study receives only the text they send. Chrome makes that promise; this app cannot check it. The first use may download a speech pack (about 60 MB). Participants on phones, Safari and Firefox will not see the microphone and will type instead.',
  },
  {
    value: 'browser',
    label: 'The browser’s own dictation',
    detail: 'No setup. Chrome sends the audio to Google and Safari to Apple, under their terms, and Firefox does not support it. Use only where your ethics approval allows these processors.',
  },
];

export function VoiceInputSection({ draft, editing, onEdit, transcriptionAvailable, hosted }: VoiceInputSectionProps) {
  const current = OPTIONS.find((option) => option.value === draft.voiceInput) ?? OPTIONS[0];
  return (
    <Section
      id="voice-input"
      label="Voice Input"
      description="Lets participants speak an answer instead of typing it. The text appears in their answer box to check and edit before sending, and the consent page names who turns speech into text."
      editing={editing}
      onEdit={onEdit}
      read={<p className="font-sans text-[15px] text-ink-900">{current.label}</p>}
    >
      <fieldset className="space-y-3">
        <legend className="sr-only">Voice input</legend>
        {OPTIONS.map((option) => {
          const unavailable = option.value === 'installation' && (hosted || !transcriptionAvailable) && draft.voiceInput !== 'installation';
          return (
            <label key={option.value} className={`flex items-start gap-3 font-sans ${unavailable ? 'opacity-50' : ''}`}>
              <input
                type="radio"
                name="voice-input"
                value={option.value}
                checked={draft.voiceInput === option.value}
                disabled={unavailable}
                onChange={() => draft.setVoiceInput(option.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-[15px] text-ink-900">{option.label}</span>
                <span className="block max-w-measure text-[13px] leading-[20px] text-ink-500">{option.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {(hosted || !transcriptionAvailable) && (
        <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
          {hosted
            ? 'Transcription by this installation is not offered on the hosted service.'
            : 'Transcription by this installation is not set up. On Cloudflare, update the installation (it adds the Workers AI binding); on Node, set CLOUDFLARE_WORKERS_AI_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_TOKEN.'}
        </p>
      )}
    </Section>
  );
}
