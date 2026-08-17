'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { Shield, ArrowRight, ArrowLeft, MessageSquare, Clock, HelpCircle, Loader2 } from 'lucide-react';
import { PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { buildParticipantOrPreviewHeaders } from '@/services/participantHeaders';

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
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <p className="text-stone-400">No study configured. Please set up a study first.</p>
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
    <div className="min-h-screen bg-stone-900 flex items-center justify-center p-4 sm:p-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-lg w-full"
      >
        <div className="bg-stone-800/50 rounded-xl border border-stone-700 overflow-hidden">
          {/* Header */}
          <div className="bg-stone-700 p-6">
            <div className="flex items-center gap-3 mb-2">
              <Shield size={28} className="text-stone-300" />
              <h1 className="text-2xl font-bold text-white">Research Consent</h1>
            </div>
            <p className="text-stone-400 text-sm">
              {studyConfig.name}
            </p>
          </div>

          {/* Content */}
          <div className="p-4 space-y-6 sm:p-6">
            <div className="prose prose-sm max-w-none text-stone-300">
              <p className="whitespace-pre-wrap">{studyConfig.consentText}</p>
            </div>

            {/* Interview Structure Foreshadowing */}
            <div className="bg-stone-800 rounded-xl p-5 space-y-4">
              <h3 className="font-semibold text-stone-100 flex items-center gap-2">
                <MessageSquare size={18} className="text-stone-400" />
                Interview Structure
              </h3>

              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-stone-700 flex items-center justify-center text-xs text-stone-400 flex-shrink-0 mt-0.5">1</div>
                  <div>
                    <div className="text-stone-200">Brief background questions</div>
                    <div className="text-stone-500 text-xs">Help us understand your context</div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-stone-700 flex items-center justify-center text-xs text-stone-400 flex-shrink-0 mt-0.5">2</div>
                  <div>
                    <div className="text-stone-200">{studyConfig.coreQuestions.length} core questions about your experiences</div>
                    <div className="text-stone-500 text-xs">The heart of the interview</div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-stone-700 flex items-center justify-center text-xs text-stone-400 flex-shrink-0 mt-0.5">
                    <HelpCircle size={12} />
                  </div>
                  <div>
                    <div className="text-stone-200">The AI may ask follow-up questions</div>
                    <div className="text-stone-500 text-xs">To better understand your perspective</div>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-stone-700 flex items-center justify-center text-xs text-stone-400 flex-shrink-0 mt-0.5">3</div>
                  <div>
                    <div className="text-stone-200">A final question for your feedback</div>
                    <div className="text-stone-500 text-xs">Your thoughts on the interview itself</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-stone-700 text-stone-400 text-sm">
                <Clock size={14} />
                <span>Estimated time: 10-15 minutes</span>
              </div>
            </div>

            <div className="bg-stone-800 border border-stone-600 rounded-xl p-4 text-sm text-stone-300">
              <strong className="text-stone-100">Data notice:</strong> {providerDisclosure} The researcher is the
              study&apos;s data controller and controls its storage and retention settings. Do not include information
              you do not want to share. Contact the researcher for retention, access, and deletion details.
            </div>
            {!providerConfigurationReady && (
              <p role="alert" className="text-sm text-amber-200 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2">
                This interview is unavailable until the researcher reviews and saves its AI provider settings.
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="p-4 pt-0 space-y-3 sm:p-6 sm:pt-0">
            {consentError && (
              <p role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
                {consentError}
              </p>
            )}
            <div className="flex gap-3">
            {viewMode !== 'participant' && (
              <button
                onClick={handleBack}
                disabled={isSubmitting}
                className="px-6 py-3 border border-stone-600 text-stone-400 rounded-xl hover:bg-stone-700 transition-colors flex items-center gap-2"
              >
                <ArrowLeft size={18} /> Back
              </button>
            )}
            <button
              onClick={handleConsent}
              disabled={isSubmitting || !providerConfigurationReady}
              aria-busy={isSubmitting}
              className="flex-1 py-3 bg-stone-600 hover:bg-stone-500 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <><Loader2 size={18} className="animate-spin" /> Recording consent...</>
              ) : (
                <>I Consent - Begin Interview <ArrowRight size={18} /></>
              )}
            </button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default Consent;
