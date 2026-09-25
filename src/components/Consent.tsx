'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { PROVIDER_MODELS, PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';
import { Button, Disclosure, Label, Verbatim } from '@/components/ui';
import NavigationStatus from '@/components/NavigationStatus';
import NoSessionNotice from '@/components/NoSessionNotice';

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
  } = useStore();
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
        // when it is still the one the study uses (Cloudflare, D9).
        body: JSON.stringify({ studyId: studyConfig.id, disclosedTransport }),
      });
      const data = await response.json().catch(() => ({})) as {
        acceptedAt?: number;
        error?: string;
      };
      if (!mounted.current) return;
      if (!response.ok || !Number.isSafeInteger(data.acceptedAt) || (data.acceptedAt ?? 0) <= 0) {
        throw new Error(data.error || 'Consent could not be recorded. Please try again.');
      }

      // This timestamp is issued by the server. It is display/resume state only;
      // participant API routes independently verify the server-side record.
      giveConsent(data.acceptedAt!);
      initializeProfile(studyConfig.profileSchema);
      setIsOpening(true);
      setStep('interview');
      router.push('/interview');
    } catch (error) {
      if (!mounted.current) return;
      setConsentError(error instanceof Error ? error.message : 'Consent could not be recorded. Please try again.');
    } finally {
      if (mounted.current) setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (isSubmitting || isOpening || isReturning) return;
    setIsReturning(true);
    setStep('setup');
    router.push('/setup');
  };

  if (isReturning) return <NavigationStatus>Returning to study setup…</NavigationStatus>;

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
    ? `The interview and any later analysis of your responses use ${selectedModelName} (${selectedProviderName}); the study does not switch them to another AI provider or model.`
    : studyConfig.aiProviderCommitment === 'may-change'
    ? 'The researcher may later analyze your responses with a different AI provider or model.'
    : null;
  const providerDisclosure = !disclosedTransport
    ? 'This page could not confirm how your responses are sent. Reopen the study link before continuing.'
    : !providerConfigurationReady
    ? 'The researcher must review and save this study\'s AI provider settings before interviews can begin.'
    : disclosedTransport === 'cloudflare-gateway'
    ? selectedProviderId === 'openrouter'
      ? 'Your responses are sent through Cloudflare AI Gateway, a relay operated by Cloudflare (which also hosts this study), to OpenRouter and a ZDR-compatible upstream inference provider selected for that model. The relay is configured not to log or cache your responses. Cloudflare may process them outside the EU.'
      : `Your responses are sent to ${selectedProviderName} through Cloudflare AI Gateway, a relay operated by Cloudflare, which also hosts this study. The relay is configured not to log or cache your responses and does not send them to any other provider. Cloudflare may process them outside the EU.`
    : disclosedTransport === 'gateway'
    ? `Your responses are sent through Vercel AI Gateway to ${selectedProviderName}. Routing is pinned to that provider and model fallback is disabled.`
    : selectedProviderId === 'openrouter'
    ? 'Your responses are sent to OpenRouter and a ZDR-compatible upstream inference provider selected for that model.'
    : `Your responses are sent to ${selectedProviderName}.`;

  return (
    <main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-measure space-y-8">
        <div>
          <Label>Research consent</Label>
          <Verbatim as="h1" className="mt-2 text-[28px] font-normal leading-[36px] text-ink-900">
            {studyConfig.name}
          </Verbatim>
        </div>

        <Verbatim className="whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">
          {studyConfig.consentText}
        </Verbatim>

        <section className="space-y-4">
          <h2 className="font-sans text-[15px] font-semibold leading-[24px] text-ink-900">
            Interview Structure
          </h2>
          <ol className="list-decimal space-y-3 pl-5 font-sans text-[15px] leading-[24px]">
            <li>
              <p className="text-ink-900">Brief background questions</p>
              <p className="text-[13px] leading-[20px] text-ink-500">Help us understand your context</p>
            </li>
            <li>
              <p className="text-ink-900">
                {studyConfig.coreQuestions.length} core question{studyConfig.coreQuestions.length !== 1 ? 's' : ''} about your experiences
              </p>
              <p className="text-[13px] leading-[20px] text-ink-500">The heart of the interview</p>
            </li>
            <li>
              <p className="text-ink-900">The AI may ask follow-up questions</p>
              <p className="text-[13px] leading-[20px] text-ink-500">To better understand your perspective</p>
            </li>
            <li>
              <p className="text-ink-900">A final question for your feedback</p>
              <p className="text-[13px] leading-[20px] text-ink-500">Your thoughts on the interview itself</p>
            </li>
          </ol>
          <p className="border-t border-ink-300 pt-4 font-sans text-[15px] leading-[24px] text-ink-700">
            Estimated time: 10-15 minutes
          </p>
        </section>

        <div className="bg-paper-2 p-4 font-sans text-[13px] leading-[20px] text-ink-700">
          <strong className="text-ink-900">Data notice:</strong>{' '}
          <span className="font-mono">
            {providerDisclosure}
            {providerCommitmentNotice ? <>{' '}{providerCommitmentNotice}</> : null}
          </span>{' '}
          The researcher is the study&apos;s data controller and controls its storage and retention settings. Do
          not include information you do not want to share. Contact the researcher for retention, access, and
          deletion details.
          {studyConfig.researcherContact
            ? <>{' '}Researcher contact: <span className="font-sans text-ink-900">{studyConfig.researcherContact}</span></>
            : null}
        </div>

        {!providerConfigurationReady && (
          <Disclosure role="alert">
            {disclosedTransport
              ? 'This interview is unavailable until the researcher reviews and saves its AI provider settings.'
              : 'This interview is unavailable until you reopen the study link.'}
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
              Back
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
            {isOpening ? 'Opening the interview…' : isSubmitting ? 'Recording consent…' : 'I consent — begin the interview'}
          </Button>
        </div>
      </div>
    </main>
  );
};

export default Consent;
