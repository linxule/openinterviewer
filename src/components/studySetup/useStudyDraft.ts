'use client';

import { useState } from 'react';
import {
  AIBehavior,
  AIProviderType,
  LinkExpirationOption,
  ProfileField,
  ProviderCommitment,
  StudyConfig,
} from '@/types';
import { DEFAULT_PROVIDER_COMMITMENT } from '@/lib/providerCommitment';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import { defaultConsentText } from '@/lib/consentText';
import { copyStudyConfiguration } from '@/lib/researcherStudyDraft';
import { studyLanguages, type InterviewLanguage } from '@/lib/i18n/languages';

export interface StudyDraft {
  name: string; description: string; researchQuestion: string;
  coreQuestions: string[]; topicAreas: string[]; profileSchema: ProfileField[];
  aiBehavior: AIBehavior; aiProvider: AIProviderType; aiModel: string;
  aiProviderCommitment: ProviderCommitment;
  enableReasoning: boolean | undefined; linkExpiration: LinkExpirationOption;
  consentText: string; researcherContact: string; thankYouText: string;
  interviewerInstructions: string;
  /** In order; the first is the default and uses consentText/thankYouText. */
  interviewLanguages: InterviewLanguage[];
  consentTranslations: Partial<Record<InterviewLanguage, string>>;
  thankYouTranslations: Partial<Record<InterviewLanguage, string>>;

  savedStudyId: string | null;
  parentStudyInfo: { id: string; name: string } | null;
  isDirty: boolean;

  setName(value: string): void;            // every setter below also sets isDirty
  setDescription(value: string): void;
  setResearchQuestion(value: string): void;
  setResearcherContact(value: string): void;
  selectProvider(id: AIProviderType): void;  // provider + DEFAULT_MODEL_BY_PROVIDER reset
  setAiModel(value: string): void;
  setAiProviderCommitment(value: ProviderCommitment): void;
  setAiBehavior(value: AIBehavior): void;
  setEnableReasoning(value: boolean | undefined): void;
  setLinkExpiration(value: LinkExpirationOption): void;
  setConsentText(value: string): void;
  setThankYouText(value: string): void;
  setInterviewerInstructions(value: string): void;
  toggleInterviewLanguage(language: InterviewLanguage): void;   // never removes the last one
  makeDefaultLanguage(language: InterviewLanguage): void;        // moves its texts into consentText/thankYouText
  setConsentTranslation(language: InterviewLanguage, value: string): void;
  setThankYouTranslation(language: InterviewLanguage, value: string): void;
  addQuestion(): void; removeQuestion(index: number): void;
  updateQuestion(index: number, value: string): void;
  addTopic(): void; removeTopic(index: number): void;
  updateTopic(index: number, value: string): void;
  addProfileField(preset?: ProfileField): void;
  removeProfileField(id: string): void;
  updateProfileField(id: string, updates: Partial<ProfileField>): void;
  toggleFieldRequired(id: string): void;

  setSavedStudyId(value: string | null): void;   // not dirtying
  setParentStudyInfo(value: { id: string; name: string } | null): void;
  setIsDirty(value: boolean): void;
  hydratePrefill(config: Partial<StudyConfig>): void;   // not dirtying
  syncFromStudyConfig(config: StudyConfig): void;       // not dirtying
  snapshotConfig(): StudyConfig; // raw form values, including unfinished rows
  buildConfig(mode: 'create' | 'update'): StudyConfig;
}

export function useStudyDraft(studyConfig: StudyConfig | null): StudyDraft {
  const [baseConfig, setBaseConfig] = useState(studyConfig);
  const [name, setNameState] = useState(studyConfig?.name || '');
  const [description, setDescriptionState] = useState(studyConfig?.description || '');
  const [researchQuestion, setResearchQuestionState] = useState(studyConfig?.researchQuestion || '');
  const [coreQuestions, setCoreQuestions] = useState<string[]>(
    studyConfig?.coreQuestions || ['']
  );
  const [topicAreas, setTopicAreas] = useState<string[]>(
    studyConfig?.topicAreas || ['']
  );
  const [profileSchema, setProfileSchema] = useState<ProfileField[]>(
    studyConfig?.profileSchema || []
  );
  const [aiBehavior, setAiBehaviorState] = useState<AIBehavior>(
    studyConfig?.aiBehavior || 'standard'
  );
  const [aiProvider, setAiProvider] = useState<AIProviderType>(
    studyConfig?.aiProvider || 'gemini'
  );
  const [aiModel, setAiModelState] = useState<string>(
    studyConfig?.aiModel || DEFAULT_MODEL_BY_PROVIDER[studyConfig?.aiProvider || 'gemini']
  );
  // A study saved before the commitment existed shows the default, so saving
  // it records an explicit choice.
  const [aiProviderCommitment, setAiProviderCommitmentState] = useState<ProviderCommitment>(
    studyConfig?.aiProviderCommitment ?? DEFAULT_PROVIDER_COMMITMENT
  );
  const [enableReasoning, setEnableReasoningState] = useState<boolean | undefined>(
    studyConfig?.enableReasoning
  );
  const [linkExpiration, setLinkExpirationState] = useState<LinkExpirationOption>(
    studyConfig?.linkExpiration || '30days'
  );
  const [consentText, setConsentTextState] = useState(studyConfig?.consentText ?? '');
  const [researcherContact, setResearcherContactState] = useState(studyConfig?.researcherContact ?? '');
  const [thankYouText, setThankYouTextState] = useState(studyConfig?.thankYouText ?? '');
  const [interviewerInstructions, setInterviewerInstructionsState] = useState(studyConfig?.interviewerInstructions ?? '');
  const [interviewLanguages, setInterviewLanguages] = useState<InterviewLanguage[]>(
    studyConfig ? studyLanguages(studyConfig) : ['en']
  );
  const [consentTranslations, setConsentTranslations] = useState<Partial<Record<InterviewLanguage, string>>>(
    { ...(studyConfig?.consentTextTranslations ?? {}) }
  );
  const [thankYouTranslations, setThankYouTranslations] = useState<Partial<Record<InterviewLanguage, string>>>(
    { ...(studyConfig?.thankYouTextTranslations ?? {}) }
  );

  const [savedStudyId, setSavedStudyId] = useState<string | null>(studyConfig?.id ?? null);
  const [parentStudyInfo, setParentStudyInfo] = useState<{ id: string; name: string } | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const setName = (value: string) => { setNameState(value); setIsDirty(true); };
  const setDescription = (value: string) => { setDescriptionState(value); setIsDirty(true); };
  const setResearchQuestion = (value: string) => { setResearchQuestionState(value); setIsDirty(true); };
  const setResearcherContact = (value: string) => { setResearcherContactState(value); setIsDirty(true); };

  const selectProvider = (id: AIProviderType) => {
    setAiProvider(id);
    // Reset model to provider's default when switching providers
    setAiModelState(DEFAULT_MODEL_BY_PROVIDER[id]);
    setIsDirty(true);
  };
  const setAiModel = (value: string) => { setAiModelState(value); setIsDirty(true); };
  const setAiBehavior = (value: AIBehavior) => { setAiBehaviorState(value); setIsDirty(true); };
  const setEnableReasoning = (value: boolean | undefined) => { setEnableReasoningState(value); setIsDirty(true); };
  const setAiProviderCommitment = (value: ProviderCommitment) => { setAiProviderCommitmentState(value); setIsDirty(true); };
  const setLinkExpiration = (value: LinkExpirationOption) => { setLinkExpirationState(value); setIsDirty(true); };
  const setConsentText = (value: string) => { setConsentTextState(value); setIsDirty(true); };
  const setThankYouText = (value: string) => { setThankYouTextState(value); setIsDirty(true); };
  const setInterviewerInstructions = (value: string) => { setInterviewerInstructionsState(value); setIsDirty(true); };

  const toggleInterviewLanguage = (language: InterviewLanguage) => {
    if (interviewLanguages.includes(language)) {
      if (interviewLanguages.length === 1) return;
      // Removing the default promotes the next language with its texts.
      if (interviewLanguages[0] === language) makeDefaultLanguage(interviewLanguages[1]);
      setInterviewLanguages((current) => current.filter((entry) => entry !== language));
    } else {
      setInterviewLanguages((current) => [...current, language]);
    }
    setIsDirty(true);
  };
  const makeDefaultLanguage = (language: InterviewLanguage) => {
    const previous = interviewLanguages[0];
    if (previous === language || !interviewLanguages.includes(language)) return;
    const nextConsent = { ...consentTranslations, [previous]: consentText };
    const nextThankYou = { ...thankYouTranslations, [previous]: thankYouText };
    setConsentTextState(consentTranslations[language] ?? '');
    setThankYouTextState(thankYouTranslations[language] ?? '');
    delete nextConsent[language];
    delete nextThankYou[language];
    setConsentTranslations(nextConsent);
    setThankYouTranslations(nextThankYou);
    setInterviewLanguages((current) => [language, ...current.filter((entry) => entry !== language)]);
    setIsDirty(true);
  };
  const setConsentTranslation = (language: InterviewLanguage, value: string) => {
    setConsentTranslations((current) => ({ ...current, [language]: value }));
    setIsDirty(true);
  };
  const setThankYouTranslation = (language: InterviewLanguage, value: string) => {
    setThankYouTranslations((current) => ({ ...current, [language]: value }));
    setIsDirty(true);
  };

  // Question management
  const addQuestion = () => { setCoreQuestions([...coreQuestions, '']); setIsDirty(true); };
  const removeQuestion = (index: number) => {
    if (coreQuestions.length > 1) {
      setCoreQuestions(coreQuestions.filter((_, i) => i !== index));
      setIsDirty(true);
    }
  };
  const updateQuestion = (index: number, value: string) => {
    const updated = [...coreQuestions];
    updated[index] = value;
    setCoreQuestions(updated);
    setIsDirty(true);
  };

  // Topic management
  const addTopic = () => { setTopicAreas([...topicAreas, '']); setIsDirty(true); };
  const removeTopic = (index: number) => {
    if (topicAreas.length > 1) {
      setTopicAreas(topicAreas.filter((_, i) => i !== index));
      setIsDirty(true);
    }
  };
  const updateTopic = (index: number, value: string) => {
    const updated = [...topicAreas];
    updated[index] = value;
    setTopicAreas(updated);
    setIsDirty(true);
  };

  // Profile field management
  const addProfileField = (preset?: ProfileField) => {
    if (preset) {
      if (!profileSchema.some(f => f.id === preset.id)) {
        setProfileSchema([...profileSchema, preset]);
        setIsDirty(true);
      }
    } else {
      const newField: ProfileField = {
        id: `field-${Date.now()}`,
        label: '',
        extractionHint: '',
        required: false
      };
      setProfileSchema([...profileSchema, newField]);
      setIsDirty(true);
    }
  };

  const removeProfileField = (id: string) => {
    setProfileSchema(profileSchema.filter(f => f.id !== id));
    setIsDirty(true);
  };

  const updateProfileField = (id: string, updates: Partial<ProfileField>) => {
    setProfileSchema(profileSchema.map(f =>
      f.id === id ? { ...f, ...updates } : f
    ));
    setIsDirty(true);
  };

  const toggleFieldRequired = (id: string) => {
    setProfileSchema(profileSchema.map(f =>
      f.id === id ? { ...f, required: !f.required } : f
    ));
    setIsDirty(true);
  };

  const hydratePrefill = (config: Partial<StudyConfig>) => {
    syncFromStudyConfig(copyStudyConfiguration(config));
  };

  const syncFromStudyConfig = (config: StudyConfig) => {
    setBaseConfig(config);
    setNameState(config.name);
    setDescriptionState(config.description);
    setResearchQuestionState(config.researchQuestion);
    setCoreQuestions(config.coreQuestions.length > 0 ? config.coreQuestions : ['']);
    setTopicAreas(config.topicAreas.length > 0 ? config.topicAreas : ['']);
    setProfileSchema(config.profileSchema || []);
    setAiBehaviorState(config.aiBehavior);
    const provider = config.aiProvider || 'gemini';
    setAiProvider(provider);
    setAiModelState(config.aiModel || DEFAULT_MODEL_BY_PROVIDER[provider]);
    setAiProviderCommitmentState(config.aiProviderCommitment ?? DEFAULT_PROVIDER_COMMITMENT);
    setEnableReasoningState(config.enableReasoning);
    setLinkExpirationState(config.linkExpiration || 'never');
    setConsentTextState(config.consentText);
    setResearcherContactState(config.researcherContact ?? '');
    setThankYouTextState(config.thankYouText ?? '');
    setInterviewerInstructionsState(config.interviewerInstructions ?? '');
    setInterviewLanguages(studyLanguages(config));
    setConsentTranslations({ ...(config.consentTextTranslations ?? {}) });
    setThankYouTranslations({ ...(config.thankYouTextTranslations ?? {}) });
  };

  const additionalLanguages = interviewLanguages.slice(1);
  // English alone is the legacy behaviour, so it is saved without a setting
  // (older releases can still read the study); an edit that removes a setting
  // sends it, and empty maps, explicitly.
  const languageMembers = (mode: 'create' | 'update'): Partial<StudyConfig> => {
    const hadSetting = mode === 'update' && baseConfig?.interviewLanguages !== undefined;
    const englishOnly = interviewLanguages.length === 1 && interviewLanguages[0] === 'en';
    const consent = Object.fromEntries(additionalLanguages.map((language) => [
      language,
      consentTranslations[language]?.trim() || defaultConsentText(researchQuestion, language),
    ]));
    const thankYou = Object.fromEntries(additionalLanguages
      .map((language) => [language, thankYouTranslations[language]?.trim() ?? ''] as const)
      .filter(([, text]) => text));
    const hadThankYou = mode === 'update' && baseConfig?.thankYouTextTranslations !== undefined;
    const hadConsent = mode === 'update' && baseConfig?.consentTextTranslations !== undefined;
    return {
      ...(englishOnly && !hadSetting ? {} : { interviewLanguages: [...interviewLanguages] }),
      ...(additionalLanguages.length > 0 || hadConsent ? { consentTextTranslations: consent } : {}),
      ...(Object.keys(thankYou).length > 0 || hadThankYou ? { thankYouTextTranslations: thankYou } : {}),
    };
  };

  const buildConfig = (mode: 'create' | 'update'): StudyConfig => ({
    id: mode === 'update' && savedStudyId ? savedStudyId : `study-${Date.now()}`,
    name: name || 'Untitled Study',
    description,
    researchQuestion,
    coreQuestions: coreQuestions.filter(q => q.trim()),
    topicAreas: topicAreas.filter(t => t.trim()),
    profileSchema: profileSchema.filter(f => f.label.trim()),
    aiBehavior,
    aiProvider,
    aiModel,
    aiProviderCommitment,
    enableReasoning: aiProvider === 'gemini' ? enableReasoning : undefined,
    linkExpiration,
    linksEnabled: mode === 'update' ? baseConfig?.linksEnabled ?? true : true,
    consentText: consentText.trim() || defaultConsentText(researchQuestion, interviewLanguages[0]),
    ...languageMembers(mode),
    createdAt: mode === 'update' ? baseConfig?.createdAt || Date.now() : Date.now(),
    ...(researcherContact.trim() ? { researcherContact: researcherContact.trim() } : {}),
    // Deliberately not defaulted here, unlike consentText one line up: the
    // fallback text is applied at render time instead, not frozen into the
    // record — no consent hash binds it, so improving the fallback improves
    // every study that never overrode it (P12.3).
    ...(mode === 'update' || thankYouText.trim() ? { thankYouText: thankYouText.trim() } : {}),
    ...(mode === 'update' || interviewerInstructions.trim() ? { interviewerInstructions: interviewerInstructions.trim() } : {}),
    // An edit is not a new lineage: retain its source metadata unchanged.
    ...(mode === 'update' && baseConfig?.parentStudyId ? {
      parentStudyId: baseConfig.parentStudyId,
      ...(baseConfig.parentStudyName ? { parentStudyName: baseConfig.parentStudyName } : {}),
      ...(baseConfig.generatedFrom ? { generatedFrom: baseConfig.generatedFrom } : {}),
    } : {}),
    // Include parent study info if this is a follow-up
    ...(parentStudyInfo && {
      parentStudyId: parentStudyInfo.id,
      parentStudyName: parentStudyInfo.name,
      generatedFrom: 'synthesis' as const
    })
  });

  const snapshotConfig = (): StudyConfig => ({
    ...buildConfig(savedStudyId ? 'update' : 'create'),
    name, consentText, researcherContact, thankYouText, interviewerInstructions,
    coreQuestions, topicAreas, profileSchema,
    // Raw texts, so an unfinished translation survives a reload; English
    // alone adds nothing beyond what buildConfig already carries.
    ...(interviewLanguages.length === 1 && interviewLanguages[0] === 'en' ? {} : {
      interviewLanguages: [...interviewLanguages],
      consentTextTranslations: { ...consentTranslations },
      thankYouTextTranslations: { ...thankYouTranslations },
    }),
  });

  return {
    name, description, researchQuestion,
    coreQuestions, topicAreas, profileSchema,
    aiBehavior, aiProvider, aiModel, aiProviderCommitment,
    enableReasoning, linkExpiration,
    consentText, researcherContact, thankYouText,
    interviewerInstructions,
    interviewLanguages, consentTranslations, thankYouTranslations,

    savedStudyId, parentStudyInfo, isDirty,

    setName, setDescription, setResearchQuestion, setResearcherContact,
    selectProvider, setAiModel, setAiProviderCommitment, setAiBehavior, setEnableReasoning, setLinkExpiration, setConsentText,
    setThankYouText,
    setInterviewerInstructions,
    toggleInterviewLanguage, makeDefaultLanguage, setConsentTranslation, setThankYouTranslation,
    addQuestion, removeQuestion, updateQuestion,
    addTopic, removeTopic, updateTopic,
    addProfileField, removeProfileField, updateProfileField, toggleFieldRequired,

    setSavedStudyId, setParentStudyInfo, setIsDirty,
    hydratePrefill, syncFromStudyConfig, buildConfig, snapshotConfig,
  };
}
