'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';
import { Button, Disclosure, Label, Verbatim } from '@/components/ui';

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
  const [consentError, setConsentError] = useState<string | null>(null);

  const handleConsent = async () => {
    if (!studyConfig || isSubmitting) return;

    setIsSubmitting(true);
    setConsentError(null);
    try {
      const response = await fetch('/api/consent', {
        method: 'POST',
        headers: buildParticipantOrPreviewHeaders({
          researcherPreview: viewMode === 'preview',
          participantSessionHandle,
        }),
        body: JSON.stringify({ studyId: studyConfig.id }),
      });
      const data = await response.json().catch(() => ({})) as {
        acceptedAt?: number;
        error?: string;
      };
      if (!response.ok || !Number.isSafeInteger(data.acceptedAt) || (data.acceptedAt ?? 0) <= 0) {
        throw new Error(data.error || 'Consent could not be recorded. Please try again.');
      }

      // This timestamp is issued by the server. It is display/resume state only;
      // participant API routes independently verify the server-side record.
      giveConsent(data.acceptedAt!);
      initializeProfile(studyConfig.profileSchema);
      setStep('interview');
      router.push('/interview');
    } catch (error) {
      setConsentError(error instanceof Error ? error.message : 'Consent could not be recorded. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    setStep('setup');
    router.push('/setup');
  };

  if (!studyConfig) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper-0">
        <p className="text-ink-500">No study configured. Please set up a study first.</p>
      </div>
    );
  }

  const selectedProviderId = studyConfig.aiProvider;
  const selectedProviderName = PROVIDER_OPTIONS.find(provider => provider.id === selectedProviderId)?.label;
  const providerConfigurationReady = Boolean(selectedProviderId && selectedProviderName && studyConfig.aiModel);
  const providerDisclosure = !providerConfigurationReady
    ? 'The researcher must review and save this study\'s AI provider settings before interviews can begin.'
    : aiTransport === 'gateway'
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
              <p className="text-[13px] text-ink-500">Help us understand your context</p>
            </li>
            <li>
              <p className="text-ink-900">{studyConfig.coreQuestions.length} core questions about your experiences</p>
              <p className="text-[13px] text-ink-500">The heart of the interview</p>
            </li>
            <li>
              <p className="text-ink-900">The AI may ask follow-up questions</p>
              <p className="text-[13px] text-ink-500">To better understand your perspective</p>
            </li>
            <li>
              <p className="text-ink-900">A final question for your feedback</p>
              <p className="text-[13px] text-ink-500">Your thoughts on the interview itself</p>
            </li>
          </ol>
          <p className="border-t border-ink-300 pt-4 font-sans text-[15px] leading-[24px] text-ink-700">
            Estimated time: 10-15 minutes
          </p>
        </section>

        <div className="rounded bg-paper-2 p-4 font-sans text-[13px] leading-5 text-ink-700">
          <strong className="text-ink-900">Data notice:</strong>{' '}
          <span className="font-mono">{providerDisclosure}</span>{' '}
          The researcher is the study&apos;s data controller and controls its storage and retention settings. Do
          not include information you do not want to share. Contact the researcher for retention, access, and
          deletion details.
        </div>

        {!providerConfigurationReady && (
          <Disclosure role="alert">
            This interview is unavailable until the researcher reviews and saves its AI provider settings.
          </Disclosure>
        )}

        {consentError && (
          <p role="alert" className="rounded bg-error px-4 py-3 text-sm text-paper-1">
            {consentError}
          </p>
        )}

        <div className="space-y-3">
          {viewMode !== 'participant' && (
            <Button type="button" variant="quiet" onClick={handleBack} disabled={isSubmitting} className="w-full">
              Back
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            onClick={handleConsent}
            disabled={isSubmitting || !providerConfigurationReady}
            aria-busy={isSubmitting}
            className="w-full"
          >
            {isSubmitting ? 'Recording consent…' : 'I consent — begin the interview'}
          </Button>
        </div>
      </div>
    </main>
  );
};

export default Consent;
