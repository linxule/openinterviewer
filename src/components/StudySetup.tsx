'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig, ProfileField, AIBehavior, AIProviderType, LinkExpirationOption } from '@/types';
import { saveStudy } from '@/services/storageService';
import {
  IDEMPOTENCY_KEY_CONSUMED,
  IDEMPOTENCY_KEY_REUSE,
} from '@/lib/studyMutationClassification';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  isKnownProviderModel,
  PROVIDER_MODELS,
  PROVIDER_OPTIONS,
} from '@/lib/providerRegistry';
import { cn } from '@/lib/cn';
import { Button, Coordinate, Field, Label, Rule } from '@/components/ui';

type ConfigStatus = {
  mode: 'hosted' | 'standalone';
  aiTransport: 'direct' | 'gateway';
  hasAnthropicKey: boolean;
  hasGeminiKey: boolean;
  hasOpenAiKey: boolean;
  hasOpenRouterKey: boolean;
};

const PROVIDER_STATUS_FIELD = {
  gemini: 'hasGeminiKey',
  claude: 'hasAnthropicKey',
  openai: 'hasOpenAiKey',
  openrouter: 'hasOpenRouterKey',
} as const satisfies Record<AIProviderType, keyof Omit<ConfigStatus, 'mode' | 'aiTransport'>>;

const PROVIDER_ENV_NAME = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const satisfies Record<AIProviderType, string>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEM_STATE_STORAGE = 'oi:create-idempotency-state';
const AUTH_EPOCH_STORAGE = 'oi:create-authority-epoch';

type PersistedCreateIdempotency = {
  intentKey: string;
  authorityEpoch: number;
  key: string;
};

const canUseSessionStorage = () =>
  typeof window !== 'undefined' && typeof sessionStorage !== 'undefined';

function readAuthorityEpoch(): number {
  if (!canUseSessionStorage()) return 0;
  const raw = sessionStorage.getItem(AUTH_EPOCH_STORAGE);
  const value = raw == null ? 0 : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeAuthorityEpoch(epoch: number) {
  if (!canUseSessionStorage()) return;
  sessionStorage.setItem(AUTH_EPOCH_STORAGE, String(epoch));
}

function readPersistedCreateIdempotency(): PersistedCreateIdempotency | null {
  if (!canUseSessionStorage()) return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(IDEM_STATE_STORAGE) || 'null') as PersistedCreateIdempotency | null;
    if (
      parsed
      && typeof parsed.intentKey === 'string'
      && Number.isSafeInteger(parsed.authorityEpoch)
      && typeof parsed.key === 'string'
      && UUID_V4.test(parsed.key)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function persistCreateIdempotency(state: PersistedCreateIdempotency) {
  if (!canUseSessionStorage()) return;
  sessionStorage.setItem(IDEM_STATE_STORAGE, JSON.stringify(state));
}

function setupIntentKey(prefill: string | null, studyId: string | null, parentId: string | null): string {
  if (prefill === 'edit' && studyId) return `edit:${studyId}`;
  if (prefill === 'followup') return parentId ? `followup:${parentId}` : 'followup';
  return 'create';
}

function isCreateIntentKey(intentKey: string): boolean {
  return intentKey === 'create' || intentKey.startsWith('followup');
}

function adoptCreateIdempotencyKey(intentKey: string, authorityEpoch: number): string {
  const stored = readPersistedCreateIdempotency();
  if (
    stored
    && stored.intentKey === intentKey
    && stored.authorityEpoch === authorityEpoch
    && UUID_V4.test(stored.key)
  ) {
    return stored.key;
  }
  const key = crypto.randomUUID();
  persistCreateIdempotency({ intentKey, authorityEpoch, key });
  return key;
}

const isProviderConfigured = (
  provider: AIProviderType,
  status: ConfigStatus | null
) => Boolean(status?.[PROVIDER_STATUS_FIELD[provider]]);

// Common profile field presets
const PROFILE_PRESETS: ProfileField[] = [
  { id: 'role', label: 'Current Role', extractionHint: 'Their job title or position', required: true },
  { id: 'industry', label: 'Industry', extractionHint: 'The industry they work in', required: false },
  { id: 'experience', label: 'Years of Experience', extractionHint: 'How many years in their field', required: false },
  { id: 'team_size', label: 'Team Size', extractionHint: 'Size of team they work with', required: false },
  { id: 'location', label: 'Location', extractionHint: 'Where they are based (city/region)', required: false }
];

const StudySetup: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    setStudyConfig,
    setStep,
    studyConfig,
    loadExampleStudy,
    setViewMode,
    setAiTransport,
  } = useStore();

  // Follow-up study state
  const [parentStudyInfo, setParentStudyInfo] = useState<{ id: string; name: string } | null>(null);

  const [name, setName] = useState(studyConfig?.name || '');
  const [description, setDescription] = useState(studyConfig?.description || '');
  const [researchQuestion, setResearchQuestion] = useState(studyConfig?.researchQuestion || '');
  const [coreQuestions, setCoreQuestions] = useState<string[]>(
    studyConfig?.coreQuestions || ['']
  );
  const [topicAreas, setTopicAreas] = useState<string[]>(
    studyConfig?.topicAreas || ['']
  );
  const [profileSchema, setProfileSchema] = useState<ProfileField[]>(
    studyConfig?.profileSchema || []
  );
  const [aiBehavior, setAiBehavior] = useState<AIBehavior>(
    studyConfig?.aiBehavior || 'standard'
  );
  const [aiProvider, setAiProvider] = useState<AIProviderType>(
    studyConfig?.aiProvider || 'gemini'
  );
  const [aiModel, setAiModel] = useState<string>(
    studyConfig?.aiModel || DEFAULT_MODEL_BY_PROVIDER[studyConfig?.aiProvider || 'gemini']
  );
  const [enableReasoning, setEnableReasoning] = useState<boolean | undefined>(
    studyConfig?.enableReasoning
  );
  const [linkExpiration, setLinkExpiration] = useState<LinkExpirationOption>(
    studyConfig?.linkExpiration || '30days'
  );
  const [consentText, setConsentText] = useState(
    studyConfig?.consentText ||
    'Thank you for participating in this research study. Your responses will be used to understand [research topic]. You may stop at any time. Do you consent to participate?'
  );

  // Participant link generation
  const [participantLink, setParticipantLink] = useState<string | null>(null);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  // Preview state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Study save state
  const [savedStudyId, setSavedStudyId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const initialPrefill = searchParams.get('prefill');
  const existingServerId = studyConfig?.id && UUID_V4.test(studyConfig.id) ? studyConfig.id : null;
  const initialIntentKey = setupIntentKey(
    initialPrefill || (existingServerId && initialPrefill !== 'followup' ? 'edit' : null),
    searchParams.get('studyId') || existingServerId,
    null
  );
  const initialAuthorityEpoch = readAuthorityEpoch();
  const initialCreateKey = isCreateIntentKey(initialIntentKey)
    ? adoptCreateIdempotencyKey(initialIntentKey, initialAuthorityEpoch)
    : null;
  const authorityEpochRef = useRef(initialAuthorityEpoch);
  const lastAuthRef = useRef<boolean | null>(null);
  const actionGenerationRef = useRef(0);
  const createCompletedRef = useRef(false);
  const intentKeyRef = useRef(initialIntentKey);
  const createIdempotencyKeyRef = useRef<string | null>(initialCreateKey);

  // Config status (API keys)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [configStatusError, setConfigStatusError] = useState<string | null>(null);

  // Sync savedStudyId with persisted config
  // Server-assigned IDs are UUIDs, client-side IDs start with "study-"
  useEffect(() => {
    if (studyConfig?.id && !studyConfig.id.startsWith('study-')) {
      // Server UUID - this is a saved study
      setSavedStudyId(studyConfig.id);
    } else {
      // No config or client-generated ID - clear to prevent overwriting other studies
      setSavedStudyId(null);
    }
  }, [studyConfig?.id]);

  // Check auth status on mount — HTTP 200 is not enough; the JSON body is the truth.
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth', { method: 'GET' });
        const data = await res.json().catch(() => ({ authenticated: false }));
        setIsAuthenticated(res.ok && data.authenticated === true);
      } catch {
        setIsAuthenticated(false);
      }
    };
    checkAuth();
  }, []);

  // Fetch config status when authenticated
  useEffect(() => {
    if (isAuthenticated !== true) {
      setConfigStatus(null);
      setConfigStatusError(null);
      return;
    }

    let cancelled = false;
    setConfigStatus(null);
    setConfigStatusError(null);

    const fetchConfigStatus = async () => {
      try {
        const res = await fetch('/api/config/status');
        const data = await res.json().catch(() => ({}));
        if (
          !res.ok ||
          (data.mode !== 'hosted' && data.mode !== 'standalone') ||
          (data.aiTransport !== 'direct' && data.aiTransport !== 'gateway') ||
          typeof data.hasAnthropicKey !== 'boolean' ||
          typeof data.hasGeminiKey !== 'boolean' ||
          (data.hasOpenAiKey !== undefined && typeof data.hasOpenAiKey !== 'boolean') ||
          (data.hasOpenRouterKey !== undefined && typeof data.hasOpenRouterKey !== 'boolean')
        ) {
          throw new Error(data.error || 'Invalid provider status response');
        }
        if (!cancelled) {
          setConfigStatus({
            mode: data.mode,
            aiTransport: data.aiTransport,
            hasAnthropicKey: data.hasAnthropicKey,
            hasGeminiKey: data.hasGeminiKey,
            // A legacy status response predating these providers is safe to
            // interpret as not configured; malformed present values fail closed.
            hasOpenAiKey: data.hasOpenAiKey === true,
            hasOpenRouterKey: data.hasOpenRouterKey === true,
          });
          setAiTransport(data.aiTransport);
        }
      } catch (error) {
        console.error('Could not verify configured AI providers:', error);
        if (!cancelled) {
          setConfigStatusError('Could not verify configured AI providers. Refresh this page and try again.');
        }
      }
    };

    void fetchConfigStatus();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, setAiTransport]);

  // Check for follow-up or edit prefill on mount
  useEffect(() => {
    const prefillType = searchParams.get('prefill');
    if (prefillType === 'followup' || prefillType === 'edit') {
      const prefillData = sessionStorage.getItem('prefillStudyConfig');
      if (prefillData) {
        try {
          const config = JSON.parse(prefillData) as Partial<StudyConfig>;
          // Populate form fields
          if (config.name) setName(config.name);
          if (config.description) setDescription(config.description);
          if (config.researchQuestion) setResearchQuestion(config.researchQuestion);
          if (config.coreQuestions?.length) setCoreQuestions(config.coreQuestions);
          if (config.topicAreas?.length) setTopicAreas(config.topicAreas);
          if (config.profileSchema?.length) setProfileSchema(config.profileSchema);
          if (config.aiBehavior) setAiBehavior(config.aiBehavior);
          if (config.aiProvider) {
            setAiProvider(config.aiProvider);
            setAiModel(config.aiModel || DEFAULT_MODEL_BY_PROVIDER[config.aiProvider]);
          } else if (config.aiModel) {
            setAiModel(config.aiModel);
          }
          if (config.enableReasoning !== undefined) setEnableReasoning(config.enableReasoning);
          if (config.linkExpiration) setLinkExpiration(config.linkExpiration);
          if (config.consentText) setConsentText(config.consentText);

          // Store parent study info for display and saving (followup only)
          if (prefillType === 'followup' && config.parentStudyId && config.parentStudyName) {
            setParentStudyInfo({
              id: config.parentStudyId,
              name: config.parentStudyName
            });
          }

          // For edit mode, set the study ID so saves become updates
          if (prefillType === 'edit') {
            const studyId = searchParams.get('studyId');
            if (studyId) {
              setSavedStudyId(studyId);
              setIsDirty(false); // Not dirty initially - matches saved state
            }
          } else {
            // Mark as dirty since we loaded prefill data that needs saving
            setIsDirty(true);
          }

          // Clear sessionStorage after loading
          sessionStorage.removeItem('prefillStudyConfig');
        } catch (error) {
          console.error('Error parsing prefill config:', error);
        }
      }
    }
  }, [searchParams]);

  // One UUID v4 per create/follow-up intent. Remounts restore via intentKey +
  // authorityEpoch. Edit never owns a key. Intent change invalidates in-flight work.
  useEffect(() => {
    const prefill = searchParams.get('prefill');
    let nextIntent = setupIntentKey(
      prefill,
      searchParams.get('studyId'),
      parentStudyInfo?.id ?? null
    );
    if (nextIntent === 'create' && intentKeyRef.current.startsWith('edit:')) {
      nextIntent = intentKeyRef.current;
    }
    const current = intentKeyRef.current;
    if (
      current === 'followup'
      && nextIntent.startsWith('followup:')
      && createIdempotencyKeyRef.current
    ) {
      intentKeyRef.current = nextIntent;
      persistCreateIdempotency({
        intentKey: nextIntent,
        authorityEpoch: authorityEpochRef.current,
        key: createIdempotencyKeyRef.current,
      });
      return;
    }
    if (nextIntent === current) {
      if (isCreateIntentKey(nextIntent) && !createIdempotencyKeyRef.current) {
        createIdempotencyKeyRef.current = adoptCreateIdempotencyKey(
          nextIntent,
          authorityEpochRef.current
        );
      }
      return;
    }
    actionGenerationRef.current += 1;
    createCompletedRef.current = false;
    setIsSaving(false);
    intentKeyRef.current = nextIntent;
    if (!isCreateIntentKey(nextIntent)) {
      createIdempotencyKeyRef.current = null;
      return;
    }
    createIdempotencyKeyRef.current = adoptCreateIdempotencyKey(
      nextIntent,
      authorityEpochRef.current
    );
  }, [searchParams, parentStudyInfo?.id]);

  useEffect(() => {
    if (isAuthenticated === null) return;
    if (lastAuthRef.current === null) {
      lastAuthRef.current = isAuthenticated;
      return;
    }
    if (lastAuthRef.current === isAuthenticated) return;
    lastAuthRef.current = isAuthenticated;
    const nextEpoch = authorityEpochRef.current + 1;
    authorityEpochRef.current = nextEpoch;
    writeAuthorityEpoch(nextEpoch);
    actionGenerationRef.current += 1;
    setIsSaving(false);
    if (isCreateIntentKey(intentKeyRef.current)) {
      createIdempotencyKeyRef.current = adoptCreateIdempotencyKey(
        intentKeyRef.current,
        nextEpoch
      );
    }
  }, [isAuthenticated]);

  // Sync form with studyConfig when it changes (e.g., after loading example)
  useEffect(() => {
    if (studyConfig) {
      setName(studyConfig.name);
      setDescription(studyConfig.description);
      setResearchQuestion(studyConfig.researchQuestion);
      setCoreQuestions(studyConfig.coreQuestions.length > 0 ? studyConfig.coreQuestions : ['']);
      setTopicAreas(studyConfig.topicAreas.length > 0 ? studyConfig.topicAreas : ['']);
      setProfileSchema(studyConfig.profileSchema || []);
      setAiBehavior(studyConfig.aiBehavior);
      const provider = studyConfig.aiProvider || 'gemini';
      setAiProvider(provider);
      setAiModel(studyConfig.aiModel || DEFAULT_MODEL_BY_PROVIDER[provider]);
      setEnableReasoning(studyConfig.enableReasoning);
      setLinkExpiration(studyConfig.linkExpiration || 'never');
      setConsentText(studyConfig.consentText);
    }
  }, [studyConfig]);

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
    consentText,
    createdAt: studyConfig?.createdAt || Date.now(),
    // Include parent study info if this is a follow-up
    ...(parentStudyInfo && {
      parentStudyId: parentStudyInfo.id,
      parentStudyName: parentStudyInfo.name,
      generatedFrom: 'synthesis' as const
    })
  });

  const requireResearcherAuth = () => {
    if (isAuthenticated === true) return true;
    router.push('/login?redirect=/setup');
    return false;
  };

  const selectedProviderConfigured = isProviderConfigured(aiProvider, configStatus);
  const selectedProvider = PROVIDER_OPTIONS.find(provider => provider.id === aiProvider)!;
  const selectedProviderName = selectedProvider.label;
  const selectedProviderEnvName = PROVIDER_ENV_NAME[aiProvider];
  const selectedProviderModels = PROVIDER_MODELS[aiProvider];
  const isCustomOpenRouterModel = aiProvider === 'openrouter'
    && !PROVIDER_MODELS.openrouter.some(model => model.id === aiModel);
  const selectedModelValid = isKnownProviderModel(aiProvider, aiModel);
  const providerUnavailableMessage = configStatusError
    || (configStatus
      ? `${selectedProviderName} is not configured for this ${configStatus.mode === 'hosted' ? 'account' : 'deployment'}.`
      : 'Configured AI providers are still being checked.');

  const requireConfiguredProvider = (reportError: (message: string) => void) => {
    if (selectedProviderConfigured) return true;
    reportError(providerUnavailableMessage);
    return false;
  };

  const requireValidModel = (reportError: (message: string) => void) => {
    if (selectedModelValid) return true;
    reportError(
      aiProvider === 'openrouter'
        ? 'Enter a valid OpenRouter provider/model slug before continuing.'
        : `Choose a supported ${selectedProviderName} model before continuing.`
    );
    return false;
  };

  const handlePreview = async () => {
    if (!requireResearcherAuth()) return;
    if (!requireConfiguredProvider(setSaveError)) return;
    if (!requireValidModel(setSaveError)) return;
    if (!savedStudyId || isDirty) {
      setSaveError('Save this study before previewing the version participants will receive.');
      return;
    }

    setIsPreviewLoading(true);
    try {
      const response = await fetch(`/api/studies/${savedStudyId}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not load the saved study.');
      }
      const data = await response.json();
      useStore.getState().resetParticipant();
      setStudyConfig(data.study.config);
      setViewMode('preview');
      setStep('consent');
      router.push('/consent');
    } catch (error) {
      console.error('Could not load saved preview:', error);
      setSaveError(error instanceof Error ? error.message : 'Could not load the saved study.');
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleGenerateLink = async () => {
    if (!requireResearcherAuth()) {
      setLinkError('auth');
      return;
    }
    if (!requireConfiguredProvider(setLinkError)) return;
    if (!requireValidModel(setLinkError)) return;
    if (!savedStudyId || isDirty) {
      setLinkError('Save this study before generating a participant link.');
      return;
    }

    setIsGeneratingLink(true);
    setLinkError(null);
    try {
      const response = await fetch(`/api/studies/${savedStudyId}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setLinkError(data.error || 'Could not load the saved study.');
        return;
      }
      const saved = await response.json();

      const linkResponse = await fetch('/api/generate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: { id: saved.study.id } })
      });

      if (!linkResponse.ok) {
        if (linkResponse.status === 401) {
          setLinkError('auth');
          setIsAuthenticated(false);
        } else {
          const data = await linkResponse.json();
          setLinkError(data.error || 'Failed to generate link');
        }
        return;
      }

      const data = await linkResponse.json();
      setParticipantLink(data.url);
    } catch (error) {
      console.error('Error generating link:', error);
      setLinkError('Network error. Please try again.');
    } finally {
      setIsGeneratingLink(false);
    }
  };

  const handleCopyLink = () => {
    if (participantLink) {
      navigator.clipboard.writeText(participantLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const applySaveIfCurrent = (
    ticket: number,
    intentKey: string,
    epoch: number,
    idempotencyKey: string | null
  ) => {
    if (ticket !== actionGenerationRef.current) return false;
    if (intentKey !== intentKeyRef.current) return false;
    if (epoch !== authorityEpochRef.current) return false;
    if (
      isCreateIntentKey(intentKey)
      && idempotencyKey
      && createIdempotencyKeyRef.current !== idempotencyKey
    ) {
      return false;
    }
    return true;
  };

  const handleSaveStudy = async () => {
    // Fix auth race condition: check for explicit false, not falsy
    if (isAuthenticated === false) {
      router.push('/login');
      return;
    }
    if (isAuthenticated === null) {
      return; // Auth check in progress - button should be disabled anyway
    }
    if (!requireConfiguredProvider(setSaveError)) return;
    if (!requireValidModel(setSaveError)) return;

    const ticket = actionGenerationRef.current;
    const intentKey = intentKeyRef.current;
    const epoch = authorityEpochRef.current;
    const isUpdate = !isCreateIntentKey(intentKey) || createCompletedRef.current;
    let idempotencyKey: string | null = null;
    if (!isUpdate) {
      idempotencyKey = createIdempotencyKeyRef.current
        ?? adoptCreateIdempotencyKey(intentKey, epoch);
      createIdempotencyKeyRef.current = idempotencyKey;
    }

    setIsSaving(true);
    setSaveSuccess(false);
    setSaveError(null);
    if (!isUpdate) {
      setSavePending(false);
    }

    const applyConfirmedUpdate = async (config: StudyConfig) => {
      const retry = await saveStudy({
        config,
        updateStudyId: savedStudyId || undefined,
        confirmed: true,
      });
      if (!applySaveIfCurrent(ticket, intentKey, epoch, idempotencyKey)) return;
      if (retry.classification.outcome === 'pending-create') {
        setSavePending(true);
        setSaveError(retry.classification.body.message || 'Study update is awaiting reconciliation.');
        return;
      }
      if (retry.classification.outcome === 'success' && retry.classification.body.study) {
        const study = retry.classification.body.study;
        setSavedStudyId(study.id);
        if (study.config) setStudyConfig(study.config as StudyConfig);
        setSaveSuccess(true);
        setIsDirty(false);
        router.push(`/studies/${study.id}`);
      }
    };

    try {
      const config = buildConfig();
      const result = await saveStudy({
        config,
        updateStudyId: isUpdate ? savedStudyId || undefined : undefined,
        idempotencyKey: isUpdate ? undefined : idempotencyKey || undefined,
      });
      if (!applySaveIfCurrent(ticket, intentKey, epoch, idempotencyKey)) return;

      const { classification } = result;
      if (classification.outcome === 'unauthorized') {
        setIsAuthenticated(false);
        router.push('/login');
        return;
      }

      if (classification.outcome === 'pending-create') {
        const study = classification.body.study;
        if (study?.id) {
          setSavedStudyId(study.id);
          if (study.config) setStudyConfig(study.config as StudyConfig);
        }
        setSavePending(true);
        return;
      }

      if (classification.outcome === 'success' && classification.body.study) {
        const study = classification.body.study;
        setSavedStudyId(study.id);
        if (study.config) setStudyConfig(study.config as StudyConfig);
        setIsDirty(false);
        if (!isUpdate) createCompletedRef.current = true;
        setSaveSuccess(true);
        router.push(`/studies/${study.id}`);
        return;
      }

      if (classification.outcome === 'confirm-required') {
        const confirmed = window.confirm(
          `${classification.warning}\n\nDo you want to continue?`
        );
        if (confirmed) await applyConfirmedUpdate(config);
        return;
      }

      if (classification.outcome === 'error') {
        const code = classification.body.code;
        if (code === IDEMPOTENCY_KEY_REUSE) {
          setSaveError('This create key was already used with a different study. Start a new save.');
          return;
        }
        if (code === IDEMPOTENCY_KEY_CONSUMED) {
          setSaveError('This create was already completed and then deleted. Start a new save.');
          return;
        }
        if (classification.status === 503) {
          setSaveError(classification.body.operationId
            ? classification.body.error || 'Study creation is awaiting reconciliation. Open My Studies to retry repair.'
            : classification.body.error || (configStatus?.mode === 'hosted'
              ? 'Storage is temporarily unavailable. Check Account & connections and try again.'
              : configStatus?.mode === 'standalone'
                ? 'Storage is unavailable. Check the self-host setup guide and run npm run setup:check, then try again.'
                : 'Storage is unavailable. Verify your account or deployment setup and try again.'));
          return;
        }
        setSaveError(classification.body.error || 'Failed to save study. Please try again.');
        return;
      }

      setSaveError('Study save did not return a saved study. Open My Studies to retry repair.');
    } catch (error) {
      console.error('Error saving study:', error);
      if (applySaveIfCurrent(ticket, intentKey, epoch, idempotencyKey)) {
        setSaveError('Network error. Please check your connection and try again.');
      }
    } finally {
      if (ticket === actionGenerationRef.current) {
        setIsSaving(false);
      }
    }
  };

  const hasRequiredFields = Boolean(name.trim() && researchQuestion.trim());
  const isValid = hasRequiredFields && selectedModelValid;

  const behaviorOptions: { id: AIBehavior; label: string; desc: string }[] = [
    {
      id: 'structured',
      label: 'Focus on covering all questions (Structured)',
      desc: 'Prioritize completion. Minimal follow-ups, redirect tangents.'
    },
    {
      id: 'standard',
      label: 'Balance coverage and depth (Standard)',
      desc: 'Default mode. Follow up on key insights, then move on.'
    },
    {
      id: 'exploratory',
      label: 'Focus on uncovering new insights (Exploratory)',
      desc: 'Prioritize depth. Chase interesting threads, probe emotions.'
    }
  ];

  const providerOptions = configStatus
    && (configStatus.mode === 'hosted' || configStatus.aiTransport === 'gateway')
    ? PROVIDER_OPTIONS.filter(provider => isProviderConfigured(provider.id, configStatus))
    : PROVIDER_OPTIONS;

  const availablePresets = PROFILE_PRESETS.filter(
    preset => !profileSchema.some(f => f.id === preset.id)
  );

  const saveVariant: 'primary' | 'quiet' = savePending || (savedStudyId && !isDirty) ? 'quiet' : 'primary';
  const saveClassName = savePending
    ? 'border-error text-error'
    : savedStudyId && !isDirty
      ? 'border-success text-success'
      : undefined;

  const sections: { id: string; label: string }[] = [
    { id: 'study-details', label: 'Study Details' },
    { id: 'profile-fields', label: 'Profile Fields' },
    { id: 'core-questions', label: 'Core Questions' },
    { id: 'topic-areas', label: 'Topic Areas' },
    { id: 'ai-provider', label: 'AI Provider' },
    { id: 'ai-interview-style', label: 'AI Interview Style' },
    { id: 'link-settings', label: 'Link Settings' },
    { id: 'consent-text', label: 'Consent Text' },
  ];

  return (
    <div>
      <div className="mb-8">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Study Setup</h1>

          <div className="order-last flex w-full flex-wrap gap-2 sm:order-none sm:ml-auto sm:w-auto">
            <Button variant="quiet" onClick={loadExampleStudy}>Load Example</Button>
            {hasRequiredFields && (
              <>
                <Button
                  onClick={handleSaveStudy}
                  disabled={!isAuthenticated || !selectedProviderConfigured || !selectedModelValid || isSaving || (!!savedStudyId && !isDirty && !savePending)}
                  variant={saveVariant}
                  className={saveClassName}
                >
                  {isSaving ? 'Saving...' : savePending ? 'Repair pending' : savedStudyId && isDirty ? 'Update Study' : savedStudyId ? 'Saved' : saveSuccess ? 'Saved!' : 'Save Study'}
                </Button>
                <Button
                  variant="quiet"
                  onClick={handlePreview}
                  disabled={isPreviewLoading || isAuthenticated !== true || !selectedProviderConfigured || !savedStudyId || isDirty}
                >
                  {isPreviewLoading ? 'Loading...' : 'Preview'}
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="font-sans text-[13px] text-ink-500">
          Configure your research interview study
        </p>
      </div>

      {saveError && (
        <div className="mb-6 flex items-start justify-between gap-3 border-l-2 border-error bg-paper-2 px-4 py-3">
          <div>
            <Label>Save Failed</Label>
            <p className="mt-1 text-[13px] text-ink-700">{saveError}</p>
          </div>
          <button
            onClick={() => setSaveError(null)}
            className="shrink-0 text-ink-500 hover:text-ink-900"
            aria-label="Dismiss save error"
          >
            ×
          </button>
        </div>
      )}

      {savePending && (
        <div className="mb-6 flex items-start justify-between gap-3 border-l-2 border-error bg-paper-2 px-4 py-3">
          <div>
            <Label>Study saved; repair pending</Label>
            <p className="mt-1 text-[13px] text-ink-700">
              The study is stored, but its hosted ownership record still needs reconciliation. Open My Studies to retry safely.
            </p>
          </div>
          <Button type="button" variant="quiet" onClick={() => router.push('/studies')}>
            My Studies
          </Button>
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[1fr_13rem] lg:items-start lg:gap-10">
        <div className="space-y-12 border border-ink-300 bg-paper-1 p-5 md:p-8">
          {parentStudyInfo && (
            <div className="border-l-2 border-ink-500 bg-paper-2 px-4 py-3">
              <Label>Follow-up Study</Label>
              <p className="mt-1 text-[13px] text-ink-700">
                Based on findings from{' '}
                <button
                  onClick={() => router.push(`/studies/${parentStudyInfo.id}`)}
                  className="text-action underline underline-offset-2 hover:text-ink-900"
                >
                  {parentStudyInfo.name}
                </button>
              </p>
            </div>
          )}

          {/* Basic Info */}
          <section id="study-details" className="space-y-4">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Study Details</h2>

            <Field label="Study Name *" htmlFor="study-name">
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setIsDirty(true); }}
                placeholder="e.g., AI Adoption in Healthcare"
                className="w-full"
              />
            </Field>

            <Field label="Research Question *" htmlFor="study-research-question">
              <textarea
                value={researchQuestion}
                onChange={(e) => { setResearchQuestion(e.target.value); setIsDirty(true); }}
                placeholder="What are you trying to understand?"
                rows={2}
                className="w-full resize-none"
              />
            </Field>

            <Field label="Description (optional)" htmlFor="study-description">
              <textarea
                value={description}
                onChange={(e) => { setDescription(e.target.value); setIsDirty(true); }}
                placeholder="Brief context about the study..."
                rows={2}
                className="w-full resize-none"
              />
            </Field>
          </section>
          <Rule />

          {/* Profile Fields */}
          <section id="profile-fields" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900">Profile Fields</h2>
              <Button variant="quiet" onClick={() => addProfileField()} className="text-[13px]">
                Add Custom
              </Button>
            </div>
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              Information to gather about participants during the interview
            </p>

            {availablePresets.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Coordinate>Quick add:</Coordinate>
                {availablePresets.map(preset => (
                  <Button
                    key={preset.id}
                    variant="quiet"
                    onClick={() => addProfileField(preset)}
                    className="px-3 py-1 text-[13px]"
                  >
                    + {preset.label}
                  </Button>
                ))}
              </div>
            )}

            <div>
              {profileSchema.map((field) => (
                <div key={field.id} className="border-b border-ink-200 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="flex-1 space-y-2">
                      <input
                        type="text"
                        value={field.label}
                        onChange={(e) => updateProfileField(field.id, { label: e.target.value })}
                        placeholder="Field label (e.g., Current Role)"
                        className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                      />
                      <input
                        type="text"
                        value={field.extractionHint}
                        onChange={(e) => updateProfileField(field.id, { extractionHint: e.target.value })}
                        placeholder="Hint for AI (e.g., Their job title or position)"
                        className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans text-[13px]"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleFieldRequired(field.id)}
                        title={field.required ? 'Required field' : 'Optional field'}
                      >
                        <Coordinate
                          className={cn(
                            'rounded border border-ink-300 px-2 py-1',
                            field.required ? 'border-ink-500 text-ink-900' : 'text-ink-500'
                          )}
                        >
                          {field.required ? 'REQ' : 'OPT'}
                        </Coordinate>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeProfileField(field.id)}
                        className="p-1.5 text-ink-500 hover:text-error"
                        aria-label={`Remove ${field.label || 'profile field'}`}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {profileSchema.length === 0 && (
                <p className="py-4 text-[13px] text-ink-500">
                  No profile fields yet. Add some above to gather participant information.
                </p>
              )}
            </div>
          </section>
          <Rule />

          {/* Core Questions */}
          <section id="core-questions" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900">Core Questions</h2>
              <Button variant="quiet" onClick={addQuestion} className="text-[13px]">
                Add Question
              </Button>
            </div>
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              Must-ask questions for your interview
            </p>
            <div className="space-y-2">
              {coreQuestions.map((q, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Coordinate className="w-6 pt-3 text-right">{i + 1}.</Coordinate>
                  <textarea
                    value={q}
                    onChange={(e) => updateQuestion(i, e.target.value)}
                    placeholder={`Question ${i + 1}...`}
                    rows={2}
                    className="flex-1 resize-none bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans"
                  />
                  {coreQuestions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeQuestion(i)}
                      className="min-h-11 px-2.5 pt-1 text-ink-500 hover:text-error"
                      aria-label={`Remove question ${i + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <Rule />

          {/* Topic Areas */}
          <section id="topic-areas" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900">Topic Areas</h2>
              <Button variant="quiet" onClick={addTopic} className="text-[13px]">
                Add Topic
              </Button>
            </div>
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              Themes the AI should probe on (e.g., fears, motivations, trade-offs)
            </p>
            <div className="space-y-2">
              {topicAreas.map((t, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Coordinate className="w-6 pt-3 text-right">{i + 1}.</Coordinate>
                  <textarea
                    value={t}
                    onChange={(e) => updateTopic(i, e.target.value)}
                    placeholder={`Topic area ${i + 1}...`}
                    rows={2}
                    className="flex-1 resize-none bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans"
                  />
                  {topicAreas.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeTopic(i)}
                      className="min-h-11 px-2.5 pt-1 text-ink-500 hover:text-error"
                      aria-label={`Remove topic ${i + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <Rule />

          {/* AI Provider */}
          <section id="ai-provider" className="space-y-4">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">AI Provider</h2>
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              Choose which AI model powers your interviews
              {configStatus?.aiTransport === 'gateway'
                ? ' through Vercel AI Gateway.'
                : '.'}
            </p>
            <div className="space-y-2">
              {providerOptions.length === 0 ? (
                <div className="border-l-2 border-error bg-paper-2 px-4 py-3">
                  <Label>No provider configured</Label>
                  <p className="mt-1 text-[13px] text-ink-700">
                    No AI provider keys are configured for this hosted account. Add one in Account &amp; connections.
                  </p>
                </div>
              ) : null}
              {providerOptions.map((option) => {
                const selected = aiProvider === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 border-l-2 py-3 pl-4',
                      selected ? 'border-l-action bg-paper-2' : 'border-l-transparent hover:bg-paper-2/50'
                    )}
                  >
                    <input
                      type="radio"
                      name="aiProvider"
                      checked={selected}
                      onChange={() => {
                        setAiProvider(option.id);
                        // Reset model to provider's default when switching providers
                        setAiModel(DEFAULT_MODEL_BY_PROVIDER[option.id]);
                        setIsDirty(true);
                      }}
                      className="mt-1 accent-action"
                    />
                    <div>
                      <div className="font-sans text-[15px] font-medium text-ink-900">{option.label}</div>
                      <div className="font-sans text-[13px] text-ink-500">{option.desc}</div>
                      {option.id === 'openrouter' ? (
                        <div className="mt-1 font-sans text-[13px] text-ink-500">
                          Requests go to OpenRouter and a ZDR-compatible upstream inference provider selected for the model.
                        </div>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Model Selection */}
            <Field
              label="Model"
              htmlFor="study-ai-model"
              hint={
                selectedProviderModels.find(model => model.id === aiModel)?.desc
                  || (isCustomOpenRouterModel
                    ? 'Custom OpenRouter model; privacy and structured-output requirements still fail closed at request time.'
                    : '')
              }
            >
              <select
                value={isCustomOpenRouterModel ? '__custom__' : aiModel}
                onChange={(event) => {
                  setAiModel(event.target.value === '__custom__' ? '' : event.target.value);
                  setIsDirty(true);
                }}
                className="w-full"
              >
                {selectedProviderModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
                {aiProvider === 'openrouter' ? <option value="__custom__">Custom provider/model ID…</option> : null}
              </select>
            </Field>

            {aiProvider === 'openrouter' && isCustomOpenRouterModel ? (
              <div className="space-y-1">
                <label
                  htmlFor="study-openrouter-custom-model"
                  className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500"
                >
                  OpenRouter model ID
                </label>
                <input
                  id="study-openrouter-custom-model"
                  type="text"
                  value={aiModel}
                  maxLength={200}
                  onChange={(event) => { setAiModel(event.target.value); setIsDirty(true); }}
                  aria-invalid={!selectedModelValid}
                  aria-describedby="study-openrouter-model-help"
                  placeholder="provider/model"
                  autoComplete="off"
                  className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans"
                />
                <p
                  id="study-openrouter-model-help"
                  className="text-[13px] text-ink-500"
                >
                  Use a provider/model slug of at most 200 characters. Automatic routing is not supported.
                </p>
              </div>
            ) : null}

            {/* Keep the legacy reasoning control Gemini-only until the stored
                study contract supports provider-specific reasoning options. */}
            {aiProvider === 'gemini' && configStatus?.aiTransport !== 'gateway' && (
              <Field
                label="AI Reasoning Mode"
                htmlFor="study-reasoning-mode"
                hint="Automatic lets Gemini choose a supported interview budget and uses high thinking for synthesis. Minimize uses each model's lowest supported interview setting and the synthesis model's low setting."
              >
                <select
                  value={enableReasoning === undefined ? 'auto' : enableReasoning ? 'on' : 'off'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEnableReasoning(v === 'auto' ? undefined : v === 'on');
                    setIsDirty(true);
                  }}
                  className="w-full"
                >
                  <option value="auto">Automatic (recommended)</option>
                  <option value="on">More thinking</option>
                  <option value="off">Minimize thinking</option>
                </select>
              </Field>
            )}

            {!selectedModelValid ? (
              <div role="alert" className="border-l-2 border-error bg-paper-2 px-4 py-3">
                <p className="text-[13px] text-ink-700">
                  {aiProvider === 'openrouter'
                    ? 'Enter a valid OpenRouter provider/model slug. Automatic routing is not supported.'
                    : `Choose a supported ${selectedProviderName} model.`}
                </p>
              </div>
            ) : null}

            {isAuthenticated === true && !configStatus && !configStatusError && (
              <div role="status" className="border-l-2 border-ink-500 bg-paper-2 px-4 py-3">
                <p className="text-[13px] text-ink-700">Checking configured AI providers…</p>
              </div>
            )}

            {isAuthenticated === true && (configStatusError || (configStatus && !selectedProviderConfigured)) && (
              <div role="alert" className="border-l-2 border-error bg-paper-2 px-4 py-3">
                <h4 className="text-[13px] font-semibold text-ink-900">
                  {configStatusError ? 'Provider availability could not be verified' : `${selectedProviderName} is not available`}
                </h4>
                <p className="mt-1 text-[13px] text-ink-700">
                  {configStatusError
                    ? configStatusError
                    : configStatus?.aiTransport === 'gateway'
                      ? `${selectedProviderName} is not enabled for this Vercel AI Gateway deployment. Choose Gemini, Claude, or OpenAI.`
                    : configStatus?.mode === 'hosted'
                      ? `This account does not have a ${selectedProviderName} key. Add one in Account & connections or finish onboarding before saving or sharing this study.`
                      : <>This deployment does not have <code className="font-mono text-ink-900">{selectedProviderEnvName}</code>. Add it server-side, run <code className="font-mono text-ink-900">npm run setup:check</code>, and redeploy before saving or sharing this study.</>}
                </p>
                {!configStatusError && configStatus?.mode === 'hosted' && (
                  <button
                    type="button"
                    onClick={() => router.push('/settings')}
                    className="mt-3 font-sans text-[13px] font-medium text-action underline underline-offset-2"
                  >
                    Account &amp; connections
                  </button>
                )}
                {!configStatusError && configStatus?.mode === 'standalone' && (
                  <button
                    type="button"
                    onClick={() => router.push('/self-host')}
                    className="mt-3 font-sans text-[13px] font-medium text-action underline underline-offset-2"
                  >
                    Open self-host setup guide
                  </button>
                )}
              </div>
            )}
          </section>
          <Rule />

          {/* AI Behavior */}
          <section id="ai-interview-style" className="space-y-4">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">AI Interview Style</h2>
            <div className="space-y-2">
              {behaviorOptions.map((option) => {
                const selected = aiBehavior === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 border-l-2 py-3 pl-4',
                      selected ? 'border-l-action bg-paper-2' : 'border-l-transparent hover:bg-paper-2/50'
                    )}
                  >
                    <input
                      type="radio"
                      name="aiBehavior"
                      checked={selected}
                      onChange={() => { setAiBehavior(option.id); setIsDirty(true); }}
                      className="mt-1 accent-action"
                    />
                    <div>
                      <div className="font-sans text-[15px] font-medium text-ink-900">{option.label}</div>
                      <div className="font-sans text-[13px] text-ink-500">{option.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </section>
          <Rule />

          {/* Link Settings */}
          <section id="link-settings" className="space-y-4">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Link Settings</h2>
            <p className="max-w-measure font-sans text-[13px] leading-[20px] text-ink-500">
              Configure when participant links expire. You can also revoke links from the study detail page.
            </p>

            <Field
              label="Link Expiration"
              htmlFor="study-link-expiration"
              hint="Expired links will show an error message when participants try to access them."
            >
              <select
                value={linkExpiration}
                onChange={(e) => { setLinkExpiration(e.target.value as LinkExpirationOption); setIsDirty(true); }}
                className="w-full"
              >
                <option value="never">Never expire</option>
                <option value="7days">Expire after 7 days</option>
                <option value="30days">Expire after 30 days</option>
                <option value="90days">Expire after 90 days</option>
              </select>
            </Field>
          </section>
          <Rule />

          {/* Consent Text */}
          <section id="consent-text" className="space-y-4">
            <Field label="Consent Text" htmlFor="study-consent-text">
              <textarea
                value={consentText}
                onChange={(e) => { setConsentText(e.target.value); setIsDirty(true); }}
                rows={4}
                className="w-full resize-none text-[13px]"
              />
            </Field>
          </section>
          <Rule />

          {/* Generate Participant Link */}
          {isValid && (
            <div className="space-y-4">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900">Participant Link</h2>

              {participantLink ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={participantLink}
                      readOnly
                      className="flex-1 bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans font-mono text-[13px]"
                    />
                    <Button type="button" variant="quiet" onClick={handleCopyLink}>
                      {linkCopied ? 'Copied!' : 'Copy'}
                    </Button>
                  </div>
                  <p className="text-[13px] text-ink-500">
                    Share this opaque link with participants. Study settings and credentials are never embedded in the URL.
                  </p>
                </div>
              ) : isAuthenticated !== true || linkError === 'auth' ? (
                <div className="space-y-3">
                  <div className="bg-paper-2 px-4 py-3">
                    <p className="mb-3 text-[13px] text-ink-700">
                      {isAuthenticated === null
                        ? 'Checking researcher sign-in…'
                        : 'Login required to generate participant links.'}
                    </p>
                    <Button type="button" variant="quiet" onClick={() => router.push('/login')}>
                      Login as Researcher
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <Button
                    type="button"
                    variant="primary"
                    className="w-full"
                    onClick={handleGenerateLink}
                    disabled={isGeneratingLink || !selectedProviderConfigured || !savedStudyId || isDirty}
                  >
                    {isGeneratingLink ? 'Generating...' : 'Generate Participant Link'}
                  </Button>
                  {linkError && linkError !== 'auth' && (
                    <p className="text-[13px] text-error">{linkError}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {isValid && <Rule />}

          {/* Submit */}
          <div className="space-y-3">
            {isAuthenticated === false && (
              <p className="text-[13px] text-ink-500">
                Researcher sign-in is required to preview or start an interview from setup.
              </p>
            )}
            <Button
              variant="primary"
              className="w-full"
              onClick={handlePreview}
              disabled={!isValid || isAuthenticated !== true || !selectedProviderConfigured || !savedStudyId || isDirty || isPreviewLoading}
            >
              Preview Saved Study
            </Button>
            {isAuthenticated === true && (!savedStudyId || isDirty) && (
              <p className="text-center text-[13px] text-ink-500">
                Save changes to preview the exact version participants will receive.
              </p>
            )}
          </div>
        </div>

        <nav aria-label="Study sections" className="hidden lg:block lg:w-52">
          <ol className="flex flex-col gap-0.5 border-l border-ink-300 pl-4">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="font-sans text-[13px] text-ink-700 hover:text-action">
                  {section.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
    </div>
  );
};

export default StudySetup;
