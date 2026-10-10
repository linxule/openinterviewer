'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig } from '@/types';
import { assignStudyProject } from '@/services/projectService';
import { isProjectId } from '@/lib/projects/validation';
import { readStudy, saveStudy } from '@/services/storageService';
import {
  IDEMPOTENCY_KEY_CONSUMED,
  IDEMPOTENCY_KEY_REUSE,
} from '@/lib/studyMutationClassification';
import {
  isKnownProviderModel,
  PROVIDER_MODELS,
  PROVIDER_OPTIONS,
} from '@/lib/providerRegistry';
import { CONSENT_TEXT_PLACEHOLDER, CONSENT_TEXT_PLACEHOLDER_ERROR } from '@/lib/consentText';
import { BRACKETED_PLACEHOLDER, THANK_YOU_TEXT_PLACEHOLDER_ERROR } from '@/lib/thankYouText';
import { Button, Coordinate, Icon, Label, Notice, Rule } from '@/components/ui';
import { useSetTrailingCrumb } from '@/components/shell/breadcrumb';
import {
  adoptCreateIdempotencyKey,
  isCreateIntentKey,
  persistCreateIdempotency,
  readAuthorityEpoch,
  releaseCreateIdempotency,
  setupIntentKey,
  writeAuthorityEpoch,
} from '@/lib/studyDraftSession';
import {
  copyStudyConfiguration, discardResearcherDraft, followupDraftSourceId, readResearcherDraft, researcherDraftKey,
  studySetupIntent, writeResearcherDraft,
} from '@/lib/researcherStudyDraft';
import { useStudyDraft } from '@/components/studySetup/useStudyDraft';
import { ConfigStatus, PROVIDER_ENV_NAME, isProviderConfigured } from '@/components/studySetup/providerStatus';
import { StudyDetailsSection } from '@/components/studySetup/StudyDetailsSection';
import { ProfileFieldsSection } from '@/components/studySetup/ProfileFieldsSection';
import { PromptListSection } from '@/components/studySetup/PromptListSection';
import { ProviderSection } from '@/components/studySetup/ProviderSection';
import { InterviewerMannerSection } from '@/components/studySetup/InterviewerMannerSection';
import { InterviewStyleSection } from '@/components/studySetup/InterviewStyleSection';
import { LinkSettingsSection } from '@/components/studySetup/LinkSettingsSection';
import { ConsentSection } from '@/components/studySetup/ConsentSection';
import { ThankYouSection } from '@/components/studySetup/ThankYouSection';
import { InterviewLanguagesSection } from '@/components/studySetup/InterviewLanguagesSection';
import { isInterviewLanguage } from '@/lib/i18n/languages';
import { VoiceInputSection } from '@/components/studySetup/VoiceInputSection';

const sectionsForExample = ['study-details', 'profile-fields', 'core-questions', 'topic-areas', 'ai-provider', 'interview-structure', 'interviewer-manner', 'interview-languages', 'voice-input', 'link-settings', 'consent-text', 'thank-you-text'];

const StudySetupForm: React.FC = () => {
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

  const projectId = searchParams.get('projectId');
  const prefillType = searchParams.get('prefill');
  const setupIntent = studySetupIntent(prefillType);
  const requestedStudyId = searchParams.get('studyId') ?? (setupIntent === 'followup' ? followupDraftSourceId() : null);
  const matchingConfig = setupIntent === 'edit' && studyConfig?.id === requestedStudyId ? studyConfig : null;
  const draft = useStudyDraft(matchingConfig);
  const [draftReady, setDraftReady] = useState(setupIntent === 'create');
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true);
  const [restoredRevisionChanged, setRestoredRevisionChanged] = useState(false);
  const baselineConfigRef = useRef<StudyConfig>(matchingConfig ?? copyStudyConfiguration({}));
  const exampleRequestedRef = useRef(false);
  const persistenceReadyRef = useRef(false);
  const draftSourceRevisionRef = useRef<number | null>(null);
  const draftSessionKey = researcherDraftKey(setupIntent, requestedStudyId);
  const draftSnapshot = JSON.stringify({ ...draft.snapshotConfig(), id: 'draft', createdAt: 0 });

  // Participant link generation
  const [participantLink, setParticipantLink] = useState<string | null>(null);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  // Preview state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Study save state
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);

  // Study revision, made legible (F1, M6)
  const [studyRevision, setStudyRevision] = useState<number | null>(null);

  const initialIntentKey = setupIntentKey(prefillType, requestedStudyId, setupIntent === 'followup' ? requestedStudyId : null, projectId);
  const [initialAuthority] = useState(() => {
    const epoch = readAuthorityEpoch();
    return {
      epoch,
      createKey: isCreateIntentKey(initialIntentKey) ? adoptCreateIdempotencyKey(initialIntentKey, epoch) : null,
    };
  });
  const authorityEpochRef = useRef(initialAuthority.epoch);
  const lastAuthRef = useRef<boolean | null>(null);
  const actionGenerationRef = useRef(0);
  const createCompletedRef = useRef(false);
  const intentKeyRef = useRef(initialIntentKey);
  const createIdempotencyKeyRef = useRef<string | null>(initialAuthority.createKey);

  // Document mode vs. edit mode (F1, M5.3): a saved study opens as a document
  // with a per-section Edit affordance; a new study opens fully editable.
  const [documentMode, setDocumentMode] = useState(setupIntent === 'edit');
  const [openSections, setOpenSections] = useState<string[]>([]);
  const isEditing = (id: string) => !documentMode || openSections.includes(id);
  const openSection = (id: string) => setOpenSections((open) => (open.includes(id) ? open : [...open, id]));
  // A saved study is a document with a name; the breadcrumb should say so rather than "New study".
  useSetTrailingCrumb(documentMode && draft.name.trim() ? draft.name.trim() : null);

  // Config status (API keys)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [configStatusError, setConfigStatusError] = useState<string | null>(null);

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
          (data.aiTransport !== 'direct' && data.aiTransport !== 'gateway' && data.aiTransport !== 'cloudflare-gateway') ||
          // Cloudflare AI Gateway exists only on the Cloudflare target.
          (data.aiTransport === 'cloudflare-gateway' && data.target !== 'cloudflare') ||
          (data.target !== undefined && data.target !== 'cloudflare') ||
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
            ...(data.target === 'cloudflare' ? { target: 'cloudflare' as const } : {}),
            aiTransport: data.aiTransport,
            hasAnthropicKey: data.hasAnthropicKey,
            hasGeminiKey: data.hasGeminiKey,
            // A legacy status response predating these providers is safe to
            // interpret as not configured; malformed present values fail closed.
            hasOpenAiKey: data.hasOpenAiKey === true,
            hasOpenRouterKey: data.hasOpenRouterKey === true,
            hasVoiceTranscription: data.hasVoiceTranscription === true,
            ...(isInterviewLanguage(data.analysisLanguage) ? { analysisLanguage: data.analysisLanguage } : {}),
            ...(data.analysisLanguageInvalid === true ? { analysisLanguageInvalid: true } : {}),
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

  // The URL owns intent and identity. A session's last preview is never edit authority.
  useEffect(() => {
    let cancelled = false;
    persistenceReadyRef.current = false;
    setDraftReady(false);
    setDraftLoadError(null);
    setRestoredDraft(false);
    setRestoredRevisionChanged(false);
    setDocumentMode(setupIntent === 'edit');
    setOpenSections([]);
    draft.setSavedStudyId(setupIntent === 'edit' && matchingConfig ? requestedStudyId : null);
    draft.setParentStudyInfo(null);
    draft.setIsDirty(false);
    if (!matchingConfig) draft.syncFromStudyConfig(copyStudyConfiguration({}));
    setParticipantLink(null);
    setLinkError(null);
    setSaveError(null);
    setSaveSuccess(false);
    setSavePending(false);
    setStudyRevision(null);

    const hydrate = (config: StudyConfig, revision: number | null) => {
      if (cancelled) return;
      baselineConfigRef.current = config;
      const restored = readResearcherDraft(draftSessionKey);
      draftSourceRevisionRef.current = restored ? restored.revision : revision;
      draft.syncFromStudyConfig(restored
        ? { ...restored.config, id: config.id, createdAt: config.createdAt, linksEnabled: config.linksEnabled }
        : config);
      draft.setSavedStudyId(setupIntent === 'edit' ? requestedStudyId : null);
      if (setupIntent === 'followup' && config.parentStudyId && config.parentStudyName) {
        draft.setParentStudyInfo({ id: config.parentStudyId, name: config.parentStudyName });
      }
      draft.setIsDirty(Boolean(restored) || setupIntent === 'duplicate' || setupIntent === 'followup');
      setRestoredDraft(Boolean(restored));
      setRestoredRevisionChanged(Boolean(restored && restored.revision !== revision && setupIntent === 'edit'));
      setStudyRevision(revision);
      persistenceReadyRef.current = true;
      setDraftReady(true);
    };

    if (setupIntent === 'edit' || setupIntent === 'duplicate') {
      if (!requestedStudyId) {
        setDraftLoadError('This study link has no study ID. Open My Studies and choose the study again.');
      } else {
        void readStudy(requestedStudyId).then(outcome => {
          if (cancelled) return;
          if (outcome.status !== 'ok') { setDraftLoadError(outcome.error); return; }
          if (outcome.value.id !== requestedStudyId || outcome.value.config.id !== requestedStudyId) {
            setDraftLoadError('The study response did not match this study. No changes have been applied.');
            return;
          }
          const canonical = outcome.value.config;
          if (setupIntent === 'duplicate') {
            hydrate(copyStudyConfiguration({ ...canonical, name: `${canonical.name} — test` }), null);
          } else {
            hydrate(canonical, outcome.value.revision ?? null);
          }
        }).catch(() => {
          if (!cancelled) setDraftLoadError('The study could not be loaded. Refresh this page and try again.');
        });
      }
    } else if (setupIntent === 'followup') {
      try {
        const config = JSON.parse(sessionStorage.getItem('prefillStudyConfig') ?? 'null') as Partial<StudyConfig> | null;
        if (!config?.parentStudyId || !config.parentStudyName) {
          setDraftLoadError('The follow-up draft is unavailable. Return to the original study to generate it again.');
        } else {
          hydrate({ ...copyStudyConfiguration(config), parentStudyId: config.parentStudyId, parentStudyName: config.parentStudyName }, null);
        }
      } catch { setDraftLoadError('The follow-up draft could not be loaded. Return to the original study.'); }
    } else {
      hydrate(copyStudyConfiguration({}), null);
    }
    return () => { cancelled = true; persistenceReadyRef.current = false; };
    // Intent changes fully replace the draft; form setters are intentionally not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupIntent, requestedStudyId, draftSessionKey]);

  // Drafts stay in this browser session, not on a live study. Preserve raw unfinished fields.
  useEffect(() => {
    if (!draftReady || !persistenceReadyRef.current || !draft.isDirty) return;
    setDraftStorageAvailable(writeResearcherDraft(draftSessionKey, JSON.parse(draftSnapshot), draftSourceRevisionRef.current));
  }, [draftReady, draft.isDirty, draftSessionKey, draftSnapshot, studyRevision, restoredRevisionChanged]);

  useEffect(() => {
    if (!draft.isDirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft.isDirty]);

  // One UUID v4 per create/follow-up intent. Remounts restore via intentKey +
  // authorityEpoch. Edit never owns a key. Intent change invalidates in-flight work.
  useEffect(() => {
    const prefill = searchParams.get('prefill');
    const nextIntent = setupIntentKey(prefill, requestedStudyId, draft.parentStudyInfo?.id ?? (setupIntent === 'followup' ? requestedStudyId : null), projectId);
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
  }, [searchParams, requestedStudyId, setupIntent, draft.parentStudyInfo?.id, projectId]);

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

  // Loading an example is explicit; unrelated preview/session state cannot hydrate this form.
  useEffect(() => {
    if (exampleRequestedRef.current && studyConfig && studyConfig.id.startsWith('study-')) {
      exampleRequestedRef.current = false;
      draft.syncFromStudyConfig({
        ...copyStudyConfiguration(studyConfig),
        ...(setupIntent === 'edit' ? {
          id: baselineConfigRef.current.id,
          createdAt: baselineConfigRef.current.createdAt,
          linksEnabled: baselineConfigRef.current.linksEnabled,
          parentStudyId: baselineConfigRef.current.parentStudyId,
          parentStudyName: baselineConfigRef.current.parentStudyName,
          generatedFrom: baselineConfigRef.current.generatedFrom,
        } : {}),
      });
      draft.setIsDirty(true);
      setOpenSections(sectionsForExample);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyConfig]);

  const discardDraft = () => {
    if (isSaving) return;
    if (!window.confirm('Discard these unsaved changes? The saved study will not change.')) return;
    setDraftStorageAvailable(discardResearcherDraft(draftSessionKey));
    draftSourceRevisionRef.current = studyRevision;
    draft.syncFromStudyConfig(baselineConfigRef.current);
    draft.setIsDirty(setupIntent === 'duplicate' || setupIntent === 'followup');
    setRestoredDraft(false);
    setRestoredRevisionChanged(false);
    setSaveError(null);
    setOpenSections([]);
  };

  const handleLoadExample = () => {
    if (isSaving) return;
    if (draft.isDirty && !window.confirm('Replace this unsaved draft with the example? The saved study will not change.')) return;
    exampleRequestedRef.current = true;
    loadExampleStudy();
  };

  const requireResearcherAuth = () => {
    if (isAuthenticated === true) return true;
    router.push('/login?redirect=/setup');
    return false;
  };

  const selectedProviderConfigured = isProviderConfigured(draft.aiProvider, configStatus);
  const selectedProvider = PROVIDER_OPTIONS.find(provider => provider.id === draft.aiProvider)!;
  const selectedProviderName = selectedProvider.label;
  const selectedProviderEnvName = PROVIDER_ENV_NAME[draft.aiProvider];
  const selectedProviderModels = PROVIDER_MODELS[draft.aiProvider];
  const isCustomOpenRouterModel = draft.aiProvider === 'openrouter'
    && !PROVIDER_MODELS.openrouter.some(model => model.id === draft.aiModel);
  const selectedModelValid = isKnownProviderModel(draft.aiProvider, draft.aiModel);
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
      draft.aiProvider === 'openrouter'
        ? 'Enter a valid OpenRouter provider/model slug before continuing.'
        : `Choose a supported ${selectedProviderName} model before continuing.`
    );
    return false;
  };

  const handlePreview = async () => {
    if (isPreviewLoading || !draftReady || isSaving) return;
    if (!requireResearcherAuth()) return;
    if (!requireConfiguredProvider(setSaveError)) return;
    if (!requireValidModel(setSaveError)) return;
    if (!draft.savedStudyId || draft.isDirty) {
      setSaveError('Save this study before previewing the version participants will receive.');
      return;
    }

    setIsPreviewLoading(true);
    try {
      const response = await fetch(`/api/studies/${draft.savedStudyId}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not load the saved study.');
      }
      const data = await response.json();
      if (!mounted.current) return;
      useStore.getState().resetParticipant();
      setStudyConfig(data.study.config);
      setViewMode('preview');
      setStep('consent');
      router.push('/consent');
    } catch (error) {
      if (!mounted.current) return;
      console.error('Could not load saved preview:', error);
      setSaveError(error instanceof Error ? error.message : 'Could not load the saved study.');
      // A failed lookup is retryable; a successful one stays locked until
      // /consent replaces this page.
      setIsPreviewLoading(false);
    }
  };

  const handleGenerateLink = async () => {
    if (!draftReady || isSaving) return;
    if (!requireResearcherAuth()) {
      setLinkError('auth');
      return;
    }
    if (!requireConfiguredProvider(setLinkError)) return;
    if (!requireValidModel(setLinkError)) return;
    if (!draft.savedStudyId || draft.isDirty) {
      setLinkError('Save this study before generating a participant link.');
      return;
    }

    setIsGeneratingLink(true);
    setLinkError(null);
    try {
      const response = await fetch(`/api/studies/${draft.savedStudyId}`);
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
    if (!mounted.current || ticket !== actionGenerationRef.current) return false;
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
    if (!draftReady || restoredRevisionChanged || isSaving) return;
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
        updateStudyId: draft.savedStudyId || undefined,
        confirmed: true,
        ...(studyRevision !== null ? { expectedRevision: studyRevision } : {}),
      });
      if (!applySaveIfCurrent(ticket, intentKey, epoch, idempotencyKey)) return;
      if (retry.classification.outcome === 'unauthorized') {
        setIsAuthenticated(false);
        router.push('/login');
        return;
      }
      if (retry.classification.outcome === 'pending-create') {
        setSavePending(true);
        setSaveError(retry.classification.body.message || 'Study update is awaiting reconciliation.');
        return;
      }
      if (retry.classification.outcome === 'success' && retry.classification.body.study) {
        const study = retry.classification.body.study;
        draft.setSavedStudyId(study.id);
        if (study.config) setStudyConfig(study.config as StudyConfig);
        discardResearcherDraft(draftSessionKey);
        setSaveSuccess(true);
        draft.setIsDirty(false);
        router.push(`/studies/${study.id}`);
        return;
      }
      setSaveError(retry.classification.outcome === 'error'
        ? retry.classification.body.error || 'The confirmed update could not be saved. Review the current study and try again.'
        : 'The confirmed update did not return a saved study. Review the current study and try again.');
    };

    try {
      const config = draft.buildConfig(isUpdate ? 'update' : 'create');
      if (CONSENT_TEXT_PLACEHOLDER.test(config.consentText)) {
        setSaveError(CONSENT_TEXT_PLACEHOLDER_ERROR);
        return;
      }
      if (config.thankYouText !== undefined && BRACKETED_PLACEHOLDER.test(config.thankYouText)) {
        setSaveError(THANK_YOU_TEXT_PLACEHOLDER_ERROR);
        return;
      }
      const result = await saveStudy({
        config,
        updateStudyId: isUpdate ? draft.savedStudyId || undefined : undefined,
        idempotencyKey: isUpdate ? undefined : idempotencyKey || undefined,
        ...(isUpdate && studyRevision !== null ? { expectedRevision: studyRevision } : {}),
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
          draft.setSavedStudyId(study.id);
          if (study.config) setStudyConfig(study.config as StudyConfig);
          if (Number.isSafeInteger(study.revision)) setStudyRevision(study.revision as number);
        }
        setSavePending(true);
        return;
      }

      if (classification.outcome === 'success' && classification.body.study) {
        const study = classification.body.study;
        draft.setSavedStudyId(study.id);
        if (study.config) setStudyConfig(study.config as StudyConfig);
        if (Number.isSafeInteger(study.revision)) setStudyRevision(study.revision as number);
        discardResearcherDraft(draftSessionKey);
        draft.setIsDirty(false);
        if (!isUpdate) {
          createCompletedRef.current = true;
          if (idempotencyKey) releaseCreateIdempotency(intentKey, epoch, idempotencyKey);
        }
        setSaveSuccess(true);
        let assignmentFailed = false;
        if (!isUpdate && configStatus?.mode === 'standalone' && projectId && isProjectId(projectId)) {
          const assignment = await assignStudyProject(study.id, projectId);
          assignmentFailed = assignment.status !== 'ok';
        }
        if (!applySaveIfCurrent(ticket, intentKey, epoch, idempotencyKey)) return;
        router.push(`/studies/${study.id}${assignmentFailed ? '?projectAssignmentFailed=1' : ''}`);
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

  const hasRequiredFields = Boolean(draft.name.trim() && draft.researchQuestion.trim());
  const isValid = hasRequiredFields && selectedModelValid;

  const providerOptions = configStatus
    && (configStatus.mode === 'hosted' || configStatus.aiTransport === 'gateway' || configStatus.target === 'cloudflare')
    ? PROVIDER_OPTIONS.filter(provider => isProviderConfigured(provider.id, configStatus))
    : PROVIDER_OPTIONS;

  const saveVariant: 'primary' | 'quiet' = savePending || (draft.savedStudyId && !draft.isDirty) ? 'quiet' : 'primary';
  const saveClassName = savePending
    ? 'border-error text-error'
    : draft.savedStudyId && !draft.isDirty
      ? 'border-success text-success'
      : undefined;

  const sections: { id: string; label: string }[] = [
    { id: 'study-details', label: 'Study Details' },
    { id: 'profile-fields', label: 'Profile Fields' },
    { id: 'core-questions', label: 'Core Questions' },
    { id: 'topic-areas', label: 'Topic Areas' },
    { id: 'ai-provider', label: 'AI Provider' },
    { id: 'interview-structure', label: 'Interview Structure' },
    { id: 'interviewer-manner', label: 'Interviewer Manner' },
    { id: 'interview-languages', label: 'Interview Languages' },
    { id: 'voice-input', label: 'Voice Input' },
    { id: 'link-settings', label: 'Link Settings' },
    { id: 'consent-text', label: 'Consent Text' },
    { id: 'thank-you-text', label: 'Thank-You Screen' },
  ];

  return (
    <div>
      <div className="mb-8">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">Study Setup</h1>

          <div className="order-last flex w-full flex-wrap gap-2 sm:order-0 sm:ml-auto sm:w-auto">
            <Button variant="quiet" onClick={handleLoadExample} disabled={!draftReady || isSaving}>Load Example</Button>
            {hasRequiredFields && (
              <>
                <Button
                  onClick={handleSaveStudy}
                  disabled={!draftReady || restoredRevisionChanged || !isAuthenticated || !selectedProviderConfigured || !selectedModelValid || isSaving || (!!draft.savedStudyId && !draft.isDirty && !savePending)}
                  variant={saveVariant}
                  className={saveClassName}
                >
                  {isSaving ? 'Saving...' : savePending ? 'Repair pending' : draft.savedStudyId && draft.isDirty ? 'Update Study' : draft.savedStudyId ? 'Saved' : saveSuccess ? 'Saved!' : 'Save Study'}
                </Button>
                <Button
                  variant="quiet"
                  onClick={handlePreview}
                  disabled={!draftReady || isSaving || isPreviewLoading || isAuthenticated !== true || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty}
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

      {isSaving && (
        <p role="status" className="mb-6 text-[13px] text-ink-500">Saving this version. Editing will resume if the save cannot be completed.</p>
      )}

      {draftLoadError ? (
        <Notice tone="error" eyebrow="Study could not be loaded" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">{draftLoadError}</p>
          <Button variant="quiet" className="mt-3" onClick={() => router.push('/studies')}>My Studies</Button>
        </Notice>
      ) : !draftReady ? (
        <p role="status" className="mb-6 text-[13px] text-ink-500">Loading this study…</p>
      ) : null}

      {draftReady && (draft.isDirty || restoredDraft) && (
        <Notice tone="neutral" eyebrow={restoredDraft ? 'Restored unsaved draft' : 'Unsaved changes'} className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">
            {draftStorageAvailable
              ? 'This draft is kept in this browser session. The saved study changes only when you save.'
              : 'Browser storage is unavailable. This draft is in memory only; keep this page open until you save.'}
          </p>
          {restoredRevisionChanged && (
            <div className="mt-2 text-[13px] text-ink-700">
              <p>The saved study changed since this draft began. Saving is paused until you review its current revision{studyRevision ? ` (${studyRevision})` : ''}. Your draft may replace newer changes.</p>
              <a href={`/studies/${encodeURIComponent(requestedStudyId ?? '')}?tab=settings`} target="_blank" rel="noreferrer" className="mt-2 inline-block min-h-11 text-action underline underline-offset-2">Review current saved study</a>
              <Button variant="quiet" className="ml-3" disabled={isSaving} onClick={() => { draftSourceRevisionRef.current = studyRevision; setRestoredRevisionChanged(false); }}>I reviewed the current revision</Button>
            </div>
          )}
          <Button variant="quiet" className="mt-3" onClick={discardDraft} disabled={isSaving}>Discard draft</Button>
        </Notice>
      )}

      {setupIntent === 'duplicate' && draftReady && (
        <Notice tone="neutral" eyebrow="Test study" className="mb-6">
          <p className="mt-1 text-[13px] text-ink-700">Only the study configuration was copied. Interviews, participant links, consent records, and analysis stay with the original study. Save this new study before previewing it.</p>
        </Notice>
      )}

      {saveError && (
        <Notice tone="error" className="mb-6 flex items-start justify-between gap-3">
          <div>
            <Label>Save Failed</Label>
            <p className="mt-1 text-[13px] text-ink-700">{saveError}</p>
          </div>
          <button
            onClick={() => setSaveError(null)}
            className="shrink-0 text-ink-500 hover:text-ink-900 min-h-11 min-w-11 inline-flex items-center justify-center"
            aria-label="Dismiss save error"
          >
            <Icon name="close" />
          </button>
        </Notice>
      )}

      {savePending && (
        <Notice tone="error" className="mb-6 flex items-start justify-between gap-3">
          <div>
            <Label>Study saved; repair pending</Label>
            <p className="mt-1 text-[13px] text-ink-700">
              The study is stored, but its hosted ownership record still needs reconciliation. Open My Studies to retry safely.
            </p>
          </div>
          <Button type="button" variant="quiet" onClick={() => router.push('/studies')}>
            My Studies
          </Button>
        </Notice>
      )}

      {documentMode && (
        <div className="mb-6 bg-paper-2 px-4 py-3">
          <Label>Revision</Label>
          {studyRevision === null ? null : (
            <Coordinate className="mt-1 block">Study revision {studyRevision}</Coordinate>
          )}
          <p className="mt-2 max-w-measure font-sans text-[13px] leading-[20px] text-ink-700">
            Editing a study advances its revision and invalidates links and participant sessions issued
            for the previous revision. Generate and distribute a new link after a consequential edit.
          </p>
        </div>
      )}

      <fieldset
        className="min-w-0 border-0 p-0 lg:grid lg:grid-cols-[1fr_13rem] lg:items-start lg:gap-10"
        disabled={!draftReady || isSaving}
        inert={!draftReady}
        aria-busy={isSaving}
        onChangeCapture={(event) => { if (isSaving) event.stopPropagation(); }}
        onClickCapture={(event) => { if (isSaving) { event.preventDefault(); event.stopPropagation(); } }}
      >
        <div className="space-y-12">
          {draft.parentStudyInfo && (
            <Notice tone="neutral" eyebrow="Follow-up Study">
              <p className="mt-1 text-[13px] text-ink-700">
                Based on findings from{' '}
                <button
                  onClick={() => router.push(`/studies/${draft.parentStudyInfo!.id}`)}
                  className="text-action underline underline-offset-2 hover:text-ink-900"
                >
                  {draft.parentStudyInfo.name}
                </button>
              </p>
            </Notice>
          )}

          <StudyDetailsSection
            draft={draft}
            editing={isEditing('study-details')}
            onEdit={() => openSection('study-details')}
          />
          <Rule />

          <ProfileFieldsSection
            draft={draft}
            editing={isEditing('profile-fields')}
            onEdit={() => openSection('profile-fields')}
          />
          <Rule />

          <PromptListSection
            draft={draft}
            editing={isEditing('core-questions')}
            onEdit={() => openSection('core-questions')}
            kind="core-questions"
          />
          <Rule />

          <PromptListSection
            draft={draft}
            editing={isEditing('topic-areas')}
            onEdit={() => openSection('topic-areas')}
            kind="topic-areas"
          />
          <Rule />

          <ProviderSection
            draft={draft}
            editing={isEditing('ai-provider')}
            onEdit={() => openSection('ai-provider')}
            configStatus={configStatus}
            configStatusError={configStatusError}
            isAuthenticated={isAuthenticated}
            selectedProviderConfigured={selectedProviderConfigured}
            selectedModelValid={selectedModelValid}
            providerOptions={providerOptions}
            selectedProviderName={selectedProviderName}
            selectedProviderEnvName={selectedProviderEnvName}
            selectedProviderModels={selectedProviderModels}
            isCustomOpenRouterModel={isCustomOpenRouterModel}
            onOpenSettings={() => router.push('/settings')}
            onOpenSelfHost={() => router.push('/self-host')}
          />
          <Rule />

          <InterviewStyleSection
            draft={draft}
            editing={isEditing('interview-structure')}
            onEdit={() => openSection('interview-structure')}
          />
          <Rule />

          <InterviewerMannerSection
            draft={draft}
            editing={isEditing('interviewer-manner')}
            onEdit={() => openSection('interviewer-manner')}
          />
          <Rule />

          <InterviewLanguagesSection
            draft={draft}
            analysisLanguage={configStatus?.analysisLanguage ?? 'en'}
            analysisLanguageInvalid={configStatus?.analysisLanguageInvalid === true}
            editing={isEditing('interview-languages')}
            onEdit={() => openSection('interview-languages')}
          />
          <Rule />

          <VoiceInputSection
            draft={draft}
            editing={isEditing('voice-input')}
            onEdit={() => openSection('voice-input')}
            transcriptionAvailable={configStatus?.hasVoiceTranscription === true}
            hosted={configStatus?.mode === 'hosted'}
          />
          <Rule />

          <LinkSettingsSection
            draft={draft}
            editing={isEditing('link-settings')}
            onEdit={() => openSection('link-settings')}
          />
          <Rule />

          <ConsentSection
            draft={draft}
            editing={isEditing('consent-text')}
            onEdit={() => openSection('consent-text')}
          />
          <Rule />

          <ThankYouSection
            draft={draft}
            editing={isEditing('thank-you-text')}
            onEdit={() => openSection('thank-you-text')}
          />
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
                      className="flex-1 bg-paper-2 border border-ink-300 rounded-sm px-3 py-2 text-ink-900 font-sans font-mono text-[13px]"
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
                    disabled={!draftReady || isSaving || isGeneratingLink || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty}
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
              disabled={!draftReady || isSaving || !isValid || isAuthenticated !== true || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty || isPreviewLoading}
            >
              Preview Saved Study
            </Button>
            {isAuthenticated === true && (!draft.savedStudyId || draft.isDirty) && (
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
      </fieldset>
    </div>
  );
};

export default function StudySetup() {
  const searchParams = useSearchParams();
  // A different intent gets a fresh component state, including asynchronous action guards.
  const intent = studySetupIntent(searchParams.get('prefill'));
  const sourceId = searchParams.get('studyId') ?? (intent === 'followup' ? followupDraftSourceId() : null);
  return <StudySetupForm key={`${intent}:${sourceId ?? 'new'}:${searchParams.get('projectId') ?? ''}`} />;
}
