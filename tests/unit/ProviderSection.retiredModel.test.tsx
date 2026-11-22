import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderSection } from '@/components/studySetup/ProviderSection';
import type { StudyDraft } from '@/components/studySetup/useStudyDraft';
import { participantTermsLine } from '@/lib/export/transcriptsMarkdown';
import { isKnownProviderModel, PROVIDER_MODELS, PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { makeStoredInterview } from '../fixtures/models';

function makeDraft(overrides: Partial<StudyDraft> = {}): StudyDraft {
  return {
    name: 'Legacy Study',
    description: 'Description',
    researchQuestion: 'Question?',
    coreQuestions: ['Core question?'],
    topicAreas: ['Topic'],
    profileSchema: [],
    aiBehavior: 'standard',
    aiProvider: 'claude',
    aiModel: 'claude-sonnet-4-5',
    aiProviderCommitment: 'fixed',
    consentText: 'Consent text',
    researcherContact: '',
    thankYouText: '',
    interviewerInstructions: '',
    interviewLanguages: [],
    consentTextTranslations: {},
    thankYouTextTranslations: {},
    voiceInput: 'off',
    linksEnabled: true,
    linkExpiration: 'never',
    enableReasoning: undefined,
    savedStudyId: 'study-legacy',
    parentStudyInfo: null,
    isDirty: false,
    setName: vi.fn(),
    setDescription: vi.fn(),
    setResearchQuestion: vi.fn(),
    setCoreQuestions: vi.fn(),
    setTopicAreas: vi.fn(),
    setProfileSchema: vi.fn(),
    setAiBehavior: vi.fn(),
    selectProvider: vi.fn(),
    setAiModel: vi.fn(),
    setAiProviderCommitment: vi.fn(),
    setConsentText: vi.fn(),
    setResearcherContact: vi.fn(),
    setThankYouText: vi.fn(),
    setInterviewerInstructions: vi.fn(),
    setInterviewLanguages: vi.fn(),
    setConsentTextTranslations: vi.fn(),
    setThankYouTextTranslations: vi.fn(),
    setVoiceInput: vi.fn(),
    setLinksEnabled: vi.fn(),
    setLinkExpiration: vi.fn(),
    setEnableReasoning: vi.fn(),
    loadStudy: vi.fn(),
    loadExample: vi.fn(),
    resetNew: vi.fn(),
    applyRestoredDraft: vi.fn(),
    markSaved: vi.fn(),
    markClean: vi.fn(),
    toStudyConfig: vi.fn(),
    toSnapshot: vi.fn(),
    ...overrides,
  } as unknown as StudyDraft;
}

describe('retired model historical safety', () => {
  it('renders a saved study with a retired model safely in ProviderSection and prompts for an active model', () => {
    const draft = makeDraft({ aiProvider: 'claude', aiModel: 'claude-sonnet-4-5' });
    const selectedModelValid = isKnownProviderModel(draft.aiProvider, draft.aiModel);
    expect(selectedModelValid).toBe(false);

    render(
      <ProviderSection
        draft={draft}
        editing
        onEdit={vi.fn()}
        configStatus={{
          mode: 'standalone',
          target: 'node',
          aiTransport: 'direct',
          providers: { gemini: true, claude: true, openai: true, openrouter: true },
          voiceInput: { installation: false },
        } as never}
        configStatusError={null}
        isAuthenticated
        selectedProviderConfigured
        selectedModelValid={selectedModelValid}
        providerOptions={PROVIDER_OPTIONS}
        selectedProviderName="Anthropic Claude"
        selectedProviderEnvName="ANTHROPIC_API_KEY"
        selectedProviderModels={PROVIDER_MODELS.claude}
        isCustomOpenRouterModel={false}
        onOpenSettings={vi.fn()}
        onOpenSelfHost={vi.fn()}
      />,
    );

    const retiredOption = screen.getByRole('option', {
      name: 'claude-sonnet-4-5 (retired — choose a supported model)',
    }) as HTMLOptionElement;
    expect(retiredOption.disabled).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a supported Anthropic Claude model.');
  });

  it('renders historical interview transcripts carrying a retired model ID without crashing', () => {
    const interview = makeStoredInterview({
      conductedByProvider: 'gemini',
      conductedByModel: 'gemini-2.5-flash',
      aiProvider: 'gemini',
      aiModel: 'gemini-2.5-flash-001',
      providerCommitment: 'fixed',
    });

    const line = participantTermsLine(interview);
    expect(line).toContain('gemini-2.5-flash (Google Gemini)');
  });
});
