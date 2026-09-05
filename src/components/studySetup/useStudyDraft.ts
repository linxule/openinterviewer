'use client';

import { useState } from 'react';
import {
  AIBehavior,
  AIProviderType,
  LinkExpirationOption,
  ProfileField,
  StudyConfig,
} from '@/types';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import { defaultConsentText } from '@/lib/consentText';

export interface StudyDraft {
  name: string; description: string; researchQuestion: string;
  coreQuestions: string[]; topicAreas: string[]; profileSchema: ProfileField[];
  aiBehavior: AIBehavior; aiProvider: AIProviderType; aiModel: string;
  enableReasoning: boolean | undefined; linkExpiration: LinkExpirationOption;
  consentText: string; researcherContact: string;

  savedStudyId: string | null;
  parentStudyInfo: { id: string; name: string } | null;
  isDirty: boolean;

  setName(value: string): void;            // every setter below also sets isDirty
  setDescription(value: string): void;
  setResearchQuestion(value: string): void;
  setResearcherContact(value: string): void;
  selectProvider(id: AIProviderType): void;  // provider + DEFAULT_MODEL_BY_PROVIDER reset
  setAiModel(value: string): void;
  setAiBehavior(value: AIBehavior): void;
  setEnableReasoning(value: boolean | undefined): void;
  setLinkExpiration(value: LinkExpirationOption): void;
  setConsentText(value: string): void;
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
  buildConfig(): StudyConfig;
}

export function useStudyDraft(studyConfig: StudyConfig | null): StudyDraft {
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
  const [enableReasoning, setEnableReasoningState] = useState<boolean | undefined>(
    studyConfig?.enableReasoning
  );
  const [linkExpiration, setLinkExpirationState] = useState<LinkExpirationOption>(
    studyConfig?.linkExpiration || '30days'
  );
  const [consentText, setConsentTextState] = useState(studyConfig?.consentText ?? '');
  const [researcherContact, setResearcherContactState] = useState(studyConfig?.researcherContact ?? '');

  const [savedStudyId, setSavedStudyId] = useState<string | null>(null);
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
  const setLinkExpiration = (value: LinkExpirationOption) => { setLinkExpirationState(value); setIsDirty(true); };
  const setConsentText = (value: string) => { setConsentTextState(value); setIsDirty(true); };

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
    if (config.name) setNameState(config.name);
    if (config.description) setDescriptionState(config.description);
    if (config.researchQuestion) setResearchQuestionState(config.researchQuestion);
    if (config.coreQuestions?.length) setCoreQuestions(config.coreQuestions);
    if (config.topicAreas?.length) setTopicAreas(config.topicAreas);
    if (config.profileSchema?.length) setProfileSchema(config.profileSchema);
    if (config.aiBehavior) setAiBehaviorState(config.aiBehavior);
    if (config.aiProvider) {
      setAiProvider(config.aiProvider);
      setAiModelState(config.aiModel || DEFAULT_MODEL_BY_PROVIDER[config.aiProvider]);
    } else if (config.aiModel) {
      setAiModelState(config.aiModel);
    }
    if (config.enableReasoning !== undefined) setEnableReasoningState(config.enableReasoning);
    if (config.linkExpiration) setLinkExpirationState(config.linkExpiration);
    if (config.consentText) setConsentTextState(config.consentText);
    if (config.researcherContact) setResearcherContactState(config.researcherContact);
  };

  const syncFromStudyConfig = (config: StudyConfig) => {
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
    setEnableReasoningState(config.enableReasoning);
    setLinkExpirationState(config.linkExpiration || 'never');
    setConsentTextState(config.consentText);
    setResearcherContactState(config.researcherContact ?? '');
  };

  const buildConfig = (): StudyConfig => ({
    id: savedStudyId || studyConfig?.id || `study-${Date.now()}`,
    name: name || 'Untitled Study',
    description,
    researchQuestion,
    coreQuestions: coreQuestions.filter(q => q.trim()),
    topicAreas: topicAreas.filter(t => t.trim()),
    profileSchema: profileSchema.filter(f => f.label.trim()),
    aiBehavior,
    aiProvider,
    aiModel,
    enableReasoning: aiProvider === 'gemini' ? enableReasoning : undefined,
    linkExpiration,
    linksEnabled: studyConfig?.linksEnabled ?? true,
    consentText: consentText.trim() || defaultConsentText(researchQuestion),
    createdAt: studyConfig?.createdAt || Date.now(),
    ...(researcherContact.trim() ? { researcherContact: researcherContact.trim() } : {}),
    // Include parent study info if this is a follow-up
    ...(parentStudyInfo && {
      parentStudyId: parentStudyInfo.id,
      parentStudyName: parentStudyInfo.name,
      generatedFrom: 'synthesis' as const
    })
  });

  return {
    name, description, researchQuestion,
    coreQuestions, topicAreas, profileSchema,
    aiBehavior, aiProvider, aiModel,
    enableReasoning, linkExpiration,
    consentText, researcherContact,

    savedStudyId, parentStudyInfo, isDirty,

    setName, setDescription, setResearchQuestion, setResearcherContact,
    selectProvider, setAiModel, setAiBehavior, setEnableReasoning, setLinkExpiration, setConsentText,
    addQuestion, removeQuestion, updateQuestion,
    addTopic, removeTopic, updateTopic,
    addProfileField, removeProfileField, updateProfileField, toggleFieldRequired,

    setSavedStudyId, setParentStudyInfo, setIsDirty,
    hydratePrefill, syncFromStudyConfig, buildConfig,
  };
}
