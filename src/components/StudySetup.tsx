'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useStore } from '@/store';
import { StudyConfig } from '@/types';
import { saveStudy } from '@/services/storageService';
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
  UUID_V4,
  adoptCreateIdempotencyKey,
  isCreateIntentKey,
  persistCreateIdempotency,
  readAuthorityEpoch,
  setupIntentKey,
  writeAuthorityEpoch,
} from '@/lib/studyDraftSession';
import { useStudyDraft } from '@/components/studySetup/useStudyDraft';
import { ConfigStatus, PROVIDER_ENV_NAME, isProviderConfigured } from '@/components/studySetup/providerStatus';
import { StudyDetailsSection } from '@/components/studySetup/StudyDetailsSection';
import { ProfileFieldsSection } from '@/components/studySetup/ProfileFieldsSection';
import { PromptListSection } from '@/components/studySetup/PromptListSection';
import { ProviderSection } from '@/components/studySetup/ProviderSection';
import { InterviewStyleSection } from '@/components/studySetup/InterviewStyleSection';
import { LinkSettingsSection } from '@/components/studySetup/LinkSettingsSection';
import { ConsentSection } from '@/components/studySetup/ConsentSection';
import { ThankYouSection } from '@/components/studySetup/ThankYouSection';

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

  const draft = useStudyDraft(studyConfig);

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
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);

  // Study revision, made legible (F1, M6)
  const [studyRevision, setStudyRevision] = useState<number | null>(null);

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

  // Document mode vs. edit mode (F1, M5.3): a saved study opens as a document
  // with a per-section Edit affordance; a new study opens fully editable.
  const editStudyId = initialPrefill === 'edit' ? searchParams.get('studyId') : null;
  const [documentMode, setDocumentMode] = useState(() => Boolean(existingServerId || editStudyId));
  const [openSections, setOpenSections] = useState<string[]>([]);
  const isEditing = (id: string) => !documentMode || openSections.includes(id);
  const openSection = (id: string) => setOpenSections((open) => (open.includes(id) ? open : [...open, id]));
  // A saved study is a document with a name; the breadcrumb should say so rather than "New study".
  useSetTrailingCrumb(documentMode && draft.name.trim() ? draft.name.trim() : null);

  // Config status (API keys)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [configStatusError, setConfigStatusError] = useState<string | null>(null);

  // Sync savedStudyId with persisted config
  // Server-assigned IDs are UUIDs, client-side IDs start with "study-"
  useEffect(() => {
    if (studyConfig?.id && !studyConfig.id.startsWith('study-')) {
      // Server UUID - this is a saved study
      draft.setSavedStudyId(studyConfig.id);
    } else {
      // No config or client-generated ID - clear to prevent overwriting other studies
      draft.setSavedStudyId(null);
      setDocumentMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          draft.hydratePrefill(config);

          // Store parent study info for display and saving (followup only)
          if (prefillType === 'followup' && config.parentStudyId && config.parentStudyName) {
            draft.setParentStudyInfo({
              id: config.parentStudyId,
              name: config.parentStudyName
            });
          }

          // For edit mode, set the study ID so saves become updates
          if (prefillType === 'edit') {
            const studyId = searchParams.get('studyId');
            if (studyId) {
              draft.setSavedStudyId(studyId);
              draft.setIsDirty(false); // Not dirty initially - matches saved state
            }
          } else {
            // Mark as dirty since we loaded prefill data that needs saving
            draft.setIsDirty(true);
          }

          // Clear sessionStorage after loading
          sessionStorage.removeItem('prefillStudyConfig');
        } catch (error) {
          console.error('Error parsing prefill config:', error);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // One UUID v4 per create/follow-up intent. Remounts restore via intentKey +
  // authorityEpoch. Edit never owns a key. Intent change invalidates in-flight work.
  useEffect(() => {
    const prefill = searchParams.get('prefill');
    let nextIntent = setupIntentKey(
      prefill,
      searchParams.get('studyId'),
      draft.parentStudyInfo?.id ?? null
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
  }, [searchParams, draft.parentStudyInfo?.id]);

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
      draft.syncFromStudyConfig(studyConfig);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyConfig]);

  // studyRevision, made legible (F1, M6.1). Display-only and fail-silent: the
  // server, not this line, is the authority on what a save may do.
  useEffect(() => {
    if (!draft.savedStudyId) { setStudyRevision(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/studies/${draft.savedStudyId}`);
        if (!res.ok) return;
        const data = await res.json();
        const revision = data?.study?.revision;
        if (!cancelled && Number.isSafeInteger(revision) && revision >= 1) setStudyRevision(revision);
      } catch { /* display only: never surface, never block */ }
    })();
    return () => { cancelled = true; };
  }, [draft.savedStudyId]);

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
        updateStudyId: draft.savedStudyId || undefined,
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
        draft.setSavedStudyId(study.id);
        if (study.config) setStudyConfig(study.config as StudyConfig);
        setSaveSuccess(true);
        draft.setIsDirty(false);
        router.push(`/studies/${study.id}`);
      }
    };

    try {
      const config = draft.buildConfig();
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
        draft.setIsDirty(false);
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

  const hasRequiredFields = Boolean(draft.name.trim() && draft.researchQuestion.trim());
  const isValid = hasRequiredFields && selectedModelValid;

  const providerOptions = configStatus
    && (configStatus.mode === 'hosted' || configStatus.aiTransport === 'gateway')
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
    { id: 'ai-interview-style', label: 'AI Interview Style' },
    { id: 'link-settings', label: 'Link Settings' },
    { id: 'consent-text', label: 'Consent Text' },
    { id: 'thank-you-text', label: 'Thank-You Screen' },
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
                  disabled={!isAuthenticated || !selectedProviderConfigured || !selectedModelValid || isSaving || (!!draft.savedStudyId && !draft.isDirty && !savePending)}
                  variant={saveVariant}
                  className={saveClassName}
                >
                  {isSaving ? 'Saving...' : savePending ? 'Repair pending' : draft.savedStudyId && draft.isDirty ? 'Update Study' : draft.savedStudyId ? 'Saved' : saveSuccess ? 'Saved!' : 'Save Study'}
                </Button>
                <Button
                  variant="quiet"
                  onClick={handlePreview}
                  disabled={isPreviewLoading || isAuthenticated !== true || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty}
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

      <div className="lg:grid lg:grid-cols-[1fr_13rem] lg:items-start lg:gap-10">
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
            editing={isEditing('ai-interview-style')}
            onEdit={() => openSection('ai-interview-style')}
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
                    disabled={isGeneratingLink || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty}
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
              disabled={!isValid || isAuthenticated !== true || !selectedProviderConfigured || !draft.savedStudyId || draft.isDirty || isPreviewLoading}
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
      </div>
    </div>
  );
};

export default StudySetup;
