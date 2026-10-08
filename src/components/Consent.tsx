'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { PROVIDER_MODELS, PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';
import { Button, Disclosure, Label, Verbatim } from '@/components/ui';
import NavigationStatus from '@/components/NavigationStatus';
import NoSessionNotice from '@/components/NoSessionNotice';
import { previewSetupDestination } from '@/lib/previewSetupDestination';
import { consentTextFor, hasLanguageSetting, LANGUAGE_NATIVE_NAMES, LANGUAGE_TAGS } from '@/lib/i18n/languages';
import { useParticipantLanguage } from '@/lib/i18n/useParticipantLanguage';

const Consent: React.FC = () => {
  const router = useRouter();
  const {
    studyConfig,
    giveConsent,
    setStep,
    viewMode,
    initializeProfile,
    participantSessionHandle,
    aiTransport,
    setParticipantLanguage,
  } = useStore();
  const { language, messages, languages } = useParticipantLanguage();
  // Only a study with a language setting sends one, so others' requests are unchanged.
  const hasSetting = studyConfig ? hasLanguageSetting(studyConfig) : false;
  const m = messages.consent;
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set once consent is recorded: the button stays unavailable until /interview
  // replaces this page, so a slow route change cannot record consent twice.
  const [isOpening, setIsOpening] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Only a known transport is disclosed; anything else fails closed.
  const disclosedTransport = aiTransport === 'direct' || aiTransport === 'gateway' || aiTransport === 'cloudflare-gateway'
    ? aiTransport
    : null;

  const handleConsent = async () => {
    if (!studyConfig || !disclosedTransport || isSubmitting || isOpening || isReturning) return;

    setIsSubmitting(true);
    setConsentError(null);
    try {
      const response = await fetch('/api/consent', {
        method: 'POST',
        headers: buildParticipantOrPreviewHeaders({
          researcherPreview: viewMode === 'preview',
          participantSessionHandle,
        }),
        // The transport this page disclosed; the server records consent only
        // when it is still the one the study uses (Cloudflare, D9). The
        // language names the consent text read, which the server hashes.
        body: JSON.stringify({ studyId: studyConfig.id, disclosedTransport, ...(hasSetting ? { language } : {}) }),
      });
      const data = await response.json().catch(() => ({})) as {
        acceptedAt?: number;
        error?: string;
        code?: string;
      };
      if (!mounted.current) return;
      if (!response.ok || !Number.isSafeInteger(data.acceptedAt) || (data.acceptedAt ?? 0) <= 0) {
        throw new Error(consentErrorCopy(response.status, data));
      }
      if (hasSetting) setParticipantLanguage(language);

      // This timestamp is issued by the server. It is display/resume state only;
      // participant API routes independently verify the server-side record.
      giveConsent(data.acceptedAt!);
      initializeProfile(studyConfig.profileSchema);
      setIsOpening(true);
      setStep('interview');
      router.push('/interview');
    } catch (error) {
      if (!mounted.current) return;
      setConsentError(error instanceof Error ? error.message : m.errors.recordFailed);
    } finally {
      if (mounted.current) setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (isSubmitting || isOpening || isReturning) return;
    setIsReturning(true);
    setStep('setup');
    router.push(viewMode === 'preview' ? previewSetupDestination(studyConfig?.id) : '/setup');
  };

  // Server copy is English; other languages show the matching message by code or status.
  function consentErrorCopy(status: number, data: { error?: string; code?: string }): string {
    if (data.code === 'DISCLOSURE_CHANGED') return m.errors.disclosureChanged;
    if (data.code === 'LANGUAGE_NOT_OFFERED') return m.errors.languageNotOffered;
    if (language === 'en' && data.error) return data.error;
    if (status === 503 || status === 429) return m.errors.unavailable;
    if (status === 401 || status === 403 || status === 409) return m.errors.reopen;
    return m.errors.recordFailed;
  }

  if (isReturning) return <NavigationStatus>{m.returning}</NavigationStatus>;

  if (!studyConfig) return <NoSessionNotice />;

  const selectedProviderId = studyConfig.aiProvider;
  const selectedProviderName = PROVIDER_OPTIONS.find(provider => provider.id === selectedProviderId)?.label;
  const providerConfigurationReady = Boolean(
    selectedProviderId && selectedProviderName && studyConfig.aiModel && disclosedTransport,
  );
  // The study's promise about the provider (lib/providerCommitment.ts). Shown
  // only with a ready configuration; absent on studies saved before it existed.
  const selectedModelName = selectedProviderId && studyConfig.aiModel
    ? PROVIDER_MODELS[selectedProviderId].find(model => model.id === studyConfig.aiModel)?.label ?? studyConfig.aiModel
    : undefined;
  const providerCommitmentNotice = !providerConfigurationReady
    ? null
    : studyConfig.aiProviderCommitment === 'fixed'
    ? selectedProviderId === 'openrouter'
      // OpenRouter picks the upstream inference provider per request (no
      // pinning), so the promise covers the service and the model only.
      ? m.commitment.fixedOpenRouter(selectedModelName!)
      : m.commitment.fixed(selectedModelName!, selectedProviderName!)
    : studyConfig.aiProviderCommitment === 'may-change'
    ? m.commitment.mayChange
    : null;
  const providerDisclosure = !disclosedTransport
    ? m.transport.unconfirmed
    : !providerConfigurationReady
    ? m.transport.notReady
    : disclosedTransport === 'cloudflare-gateway'
    ? selectedProviderId === 'openrouter'
      ? m.transport.cloudflareGatewayOpenRouter
      : m.transport.cloudflareGateway(selectedProviderName!)
    : disclosedTransport === 'gateway'
    ? m.transport.vercelGateway(selectedProviderName!)
    : selectedProviderId === 'openrouter'
    ? m.transport.directOpenRouter
    : m.transport.direct(selectedProviderName!);

  return (
    <main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-measure space-y-8">
        {languages.length > 1 && (
          <fieldset className="space-y-2 font-sans">
            <legend className="text-[13px] font-semibold leading-[20px] text-ink-900">{messages.language.label}</legend>
            <div className="flex flex-wrap gap-2">
              {languages.map((option) => (
                <label
                  key={option}
                  lang={LANGUAGE_TAGS[option]}
                  className={`cursor-pointer rounded border px-3 py-1.5 text-[15px] ${option === language ? 'border-ink-900 bg-paper-2 text-ink-900' : 'border-ink-300 text-ink-700 hover:bg-paper-2'}`}
                >
                  <input
                    type="radio"
                    name="participant-language"
                    value={option}
                    checked={option === language}
                    disabled={isSubmitting || isOpening}
                    onChange={() => setParticipantLanguage(option)}
                    className="sr-only"
                  />
                  {LANGUAGE_NATIVE_NAMES[option]}
                </label>
              ))}
            </div>
            <p className="text-[13px] leading-[20px] text-ink-500">{messages.language.hint}</p>
          </fieldset>
        )}

        <div>
          <Label>{m.label}</Label>
          <Verbatim as="h1" className="mt-2 text-[28px] font-normal leading-[36px] text-ink-900">
            {studyConfig.name}
          </Verbatim>
        </div>

        <Verbatim className="whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
          {consentTextFor(studyConfig, language)}
        </Verbatim>

        <section className="space-y-4">
          <h2 className="font-sans text-[15px] font-semibold leading-[24px] text-ink-900">
            {m.structureTitle}
          </h2>
          <ol className="list-decimal space-y-3 pl-5 font-sans text-[15px] leading-[24px]">
            <li>
              <p className="text-ink-900">{m.background}</p>
              <p className="text-[13px] leading-[20px] text-ink-500">{m.backgroundHint}</p>
            </li>
            <li>
              <p className="text-ink-900">{m.coreQuestions(studyConfig.coreQuestions.length)}</p>
              <p className="text-[13px] leading-[20px] text-ink-500">{m.coreHint}</p>
            </li>
            <li>
              <p className="text-ink-900">{m.followUps}</p>
              <p className="text-[13px] leading-[20px] text-ink-500">{m.followUpsHint}</p>
            </li>
            <li>
              <p className="text-ink-900">{m.feedback}</p>
              <p className="text-[13px] leading-[20px] text-ink-500">{m.feedbackHint}</p>
            </li>
          </ol>
          <p className="border-t border-ink-300 pt-4 font-sans text-[15px] leading-[24px] text-ink-700">
            {m.estimatedTime}
          </p>
        </section>

        <div className="bg-paper-2 p-4 font-sans text-[13px] leading-[20px] text-ink-700">
          <strong className="text-ink-900">{m.dataNoticeLabel}</strong>{' '}
          <span className="font-mono">
            {providerDisclosure}
            {providerCommitmentNotice ? <>{' '}{providerCommitmentNotice}</> : null}
            {studyConfig.voiceInput === 'installation' || studyConfig.voiceInput === 'browser'
              ? <>{' '}{m.voice[studyConfig.voiceInput]}</>
              : null}
          </span>{' '}
          {m.controller}
          {studyConfig.researcherContact
            ? <>{' '}{m.researcherContact} <span className="font-sans text-ink-900">{studyConfig.researcherContact}</span></>
            : null}
        </div>

        {!providerConfigurationReady && (
          <Disclosure role="alert">
            {disclosedTransport ? m.unavailableSettings : m.unavailableReopen}
          </Disclosure>
        )}

        {consentError && (
          <p role="alert" className="bg-error px-4 py-3 font-sans text-[15px] leading-[24px] text-paper-1">
            {consentError}
          </p>
        )}

        <div className="space-y-3">
          {viewMode !== 'participant' && (
            <Button type="button" variant="quiet" onClick={handleBack} disabled={isSubmitting || isOpening} className="w-full">
              {m.back}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            onClick={handleConsent}
            disabled={isSubmitting || isOpening || !providerConfigurationReady}
            aria-busy={isSubmitting || isOpening}
            className="w-full"
          >
            {isOpening ? m.opening : isSubmitting ? m.recording : m.accept}
          </Button>
        </div>
      </div>
    </main>
  );
};

export default Consent;
