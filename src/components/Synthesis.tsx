'use client';

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { synthesizeInterview } from '@/services/interviewApi';
import { saveCompletedInterview } from '@/services/storageService';
import { Button, Coordinate, Label, Notice, Page, Rule, Verbatim } from '@/components/ui';
import { SynthesisReading } from '@/components/SynthesisReading';
import type { SynthesisResult } from '@/types';
import { formatConsentTimestamp, formatElapsed, participantTurnCount, transcriptElapsedMs } from '@/lib/receiptFacts';

type CompletionInputs = Pick<ReturnType<typeof useStore.getState>,
  'studyConfig' | 'participantProfile' | 'interviewHistory' | 'behaviorData' | 'viewMode' | 'participantSessionHandle'
>;

type CompletionAttempt = {
  inputs: CompletionInputs;
  result: SynthesisResult | null;
  saving: boolean;
};

// These store values are immutable. A new reference invalidates the analysis
// and its receipt even if the participant remains on the synthesis page.
function sameCompletionInputs(left: CompletionInputs, right: CompletionInputs) {
  return left.studyConfig === right.studyConfig
    && left.participantProfile === right.participantProfile
    && left.interviewHistory === right.interviewHistory
    && left.behaviorData === right.behaviorData
    && left.viewMode === right.viewMode
    && left.participantSessionHandle === right.participantSessionHandle;
}

const Synthesis: React.FC = () => {
  const router = useRouter();
  const {
    studyConfig,
    participantProfile,
    interviewHistory,
    behaviorData,
    synthesis,
    setSynthesis,
    setStep,
    participantSessionHandle,
    viewMode,
    consentTimestamp
  } = useStore();

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'pending' | 'saved' | 'preview' | 'failed' | null>(null);
  const [analysisError, setAnalysisError] = useState(false);

  const mounted = useRef(false);
  const activeAttempt = useRef<CompletionAttempt | null>(null);

  // Keep the attempt across StrictMode's cleanup/setup replay, while preventing
  // an actual unmount from applying a late response or starting a save.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const isCurrentAttempt = useCallback((attempt: CompletionAttempt) => (
    mounted.current
    && activeAttempt.current === attempt
    && sameCompletionInputs(attempt.inputs, useStore.getState())
  ), []);

  // Counter to trigger re-analysis when retry is clicked
  const [retryTrigger, setRetryTrigger] = useState(0);

  // Citation notes open on first paint; keyed `${themeIndex}:${refIndex}`.
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const setNoteOpen = (themeIndex: number, refIndex: number, next: boolean) =>
    setOpenNotes((prev) => ({ ...prev, [`${themeIndex}:${refIndex}`]: next }));

  const doSave = useCallback(async (attempt: CompletionAttempt) => {
    const { studyConfig, participantProfile, interviewHistory, behaviorData, viewMode, participantSessionHandle } = attempt.inputs;
    if (!isCurrentAttempt(attempt) || attempt.saving || !studyConfig || !attempt.result) return;

    attempt.saving = true;
    setIsSaving(true);
    setSaveStatus('pending');
    try {
      // The first message is persisted with the transcript, so a missing profile
      // still produces the same submission identity/time after retry or refresh.
      const firstMessage = interviewHistory[0];
      const saveResult = await saveCompletedInterview({
        id: participantProfile?.id ?? `interview-${firstMessage.id.slice(0, 110)}`,
        studyId: studyConfig.id,
        studyName: studyConfig.name,
        participantProfile,
        transcript: interviewHistory,
        synthesis: attempt.result,
        behaviorData,
        createdAt: participantProfile?.timestamp ?? firstMessage.timestamp
      }, viewMode === 'preview', participantSessionHandle);

      if (isCurrentAttempt(attempt)) {
        setSaveStatus(saveResult.preview ? 'preview' : saveResult.success ? 'saved' : 'failed');
      }
    } catch (error) {
      if (isCurrentAttempt(attempt)) {
        console.error('Error saving interview:', error);
        setSaveStatus('failed');
      }
    } finally {
      attempt.saving = false;
      if (isCurrentAttempt(attempt)) setIsSaving(false);
    }
  }, [isCurrentAttempt]);

  const handleRetrySave = () => {
    const attempt = activeAttempt.current;
    if (attempt) void doSave(attempt);
  };

  const handleRetryAnalysis = () => {
    setAnalysisError(false);
    activeAttempt.current = null;
    setRetryTrigger(prev => prev + 1);
  };

  useEffect(() => {
    const inputs = { studyConfig, participantProfile, interviewHistory, behaviorData, viewMode, participantSessionHandle };
    const previousAttempt = activeAttempt.current;
    if (previousAttempt && sameCompletionInputs(previousAttempt.inputs, inputs)) return;

    // A synthesis generated for earlier inputs cannot authorize the new save.
    const existingSynthesis = previousAttempt && synthesis === previousAttempt.result ? null : synthesis;
    if (synthesis && !existingSynthesis) useStore.setState({ synthesis: null });

    activeAttempt.current = null;
    setIsAnalyzing(false);
    setIsSaving(false);
    setSaveStatus(null);
    setAnalysisError(false);
    if (!studyConfig || interviewHistory.length === 0) return;

    const attempt: CompletionAttempt = { inputs, result: existingSynthesis, saving: false };
    activeAttempt.current = attempt;

    if (existingSynthesis) {
      void doSave(attempt);
      return;
    }

    const analyzeAndSave = async () => {
      setIsAnalyzing(true);
      try {
        const result = await synthesizeInterview(
          inputs.interviewHistory,
          studyConfig,
          inputs.behaviorData,
          inputs.participantProfile,
          inputs.viewMode === 'preview',
          inputs.participantSessionHandle
        );
        if (!isCurrentAttempt(attempt)) return;
        attempt.result = result;
        setSynthesis(result);
        await doSave(attempt);
      } catch (error) {
        if (isCurrentAttempt(attempt)) {
          console.error('Error synthesizing interview:', error);
          setAnalysisError(true);
        }
      } finally {
        if (isCurrentAttempt(attempt)) setIsAnalyzing(false);
      }
    };

    void analyzeAndSave();
  }, [studyConfig, participantProfile, interviewHistory, behaviorData, viewMode, participantSessionHandle,
    synthesis, setSynthesis, retryTrigger, doSave, isCurrentAttempt]);

  const handleBack = () => {
    setStep('interview');
    router.push('/interview');
  };

  const handleExport = () => {
    setStep('export');
    router.push('/export');
  };

  if (!studyConfig) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-paper-0">
        <p className="font-sans text-[15px] text-ink-500">No study configured.</p>
      </div>
    );
  }

  if (viewMode === 'participant') {
    const participantState = analysisError
      ? 'analysis-failed'
      : saveStatus === 'failed' || saveStatus === 'preview'
        ? 'save-failed'
        : saveStatus === 'saved'
          ? 'saved'
          : 'finalizing';

    const elapsedMs = transcriptElapsedMs(interviewHistory);
    const consentAccepted = formatConsentTimestamp(consentTimestamp);
    const receiptFacts: { term: string; value: string; mono?: boolean }[] = participantState === 'saved'
      ? [
          { term: 'Turns contributed', value: String(participantTurnCount(interviewHistory)) },
          ...(elapsedMs === null ? [] : [{ term: 'Elapsed', value: formatElapsed(elapsedMs) }]),
          ...(consentAccepted === null ? [] : [{ term: 'Consent accepted', value: consentAccepted }]),
          ...(studyConfig.researcherContact
            ? [{ term: 'Researcher contact', value: studyConfig.researcherContact, mono: false }]
            : []),
        ]
      : [];

    return (
      <main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-measure space-y-6">
          {participantState === 'saved' ? (
            <>
              <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
                Interview submitted
              </Verbatim>
              <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="status" aria-live="polite">
                Your responses have been saved. It is now safe to close this tab.
              </p>
              {receiptFacts.length > 0 ? (
                <>
                  <Rule className="mt-2" />
                  <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2">
                    {receiptFacts.map((fact) => (
                      <React.Fragment key={fact.term}>
                        <dt><Label>{fact.term}</Label></dt>
                        <dd>{fact.mono !== false
                          ? <Coordinate className="text-[13px] text-ink-700">{fact.value}</Coordinate>
                          : <span className="font-sans text-[13px] text-ink-700">{fact.value}</span>}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </>
              ) : null}
            </>
          ) : participantState === 'analysis-failed' ? (
            <>
              <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
                We couldn&apos;t finalize your interview
              </Verbatim>
              <Notice tone="error">
                <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="alert">
                  Your responses are still in this tab, but they have not been saved. Keep this tab open and try again.
                </p>
              </Notice>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant="quiet" onClick={handleBack}>
                  Back to interview
                </Button>
                <Button variant="primary" onClick={handleRetryAnalysis}>
                  Retry finalization
                </Button>
              </div>
            </>
          ) : participantState === 'save-failed' ? (
            <>
              <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
                We couldn&apos;t save your interview
              </Verbatim>
              <Notice tone="error">
                <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="alert">
                  Your responses are still in this tab. Keep it open and retry the save before closing.
                </p>
              </Notice>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant="quiet" onClick={handleBack}>
                  Back to interview
                </Button>
                <Button variant="primary" disabled={isSaving} onClick={handleRetrySave}>
                  Retry save
                </Button>
              </div>
            </>
          ) : (
            <>
              <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
                Finalizing your interview
              </Verbatim>
              <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="status" aria-live="polite">
                We are preparing and saving your responses. Keep this tab open until you see confirmation that it is safe to close.
              </p>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-paper-0">
      <Page className="py-10 md:py-14">
        <div>
          <Label>Interview analysis</Label>
          <h1 className="mt-2 font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
            {viewMode === 'preview' ? 'Researcher preview analysis' : 'Interview Analysis'}
          </h1>
          <p className="mt-1 font-sans text-[15px] leading-[24px] text-ink-700">
            Patterns and insights from the conversation
          </p>
        </div>
        <Rule className="my-8" />

        {isAnalyzing ? (
          <div>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Analyzing Interview...</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">
              Looking for patterns, themes, and insights
            </p>
          </div>
        ) : synthesis ? (
          <div className="space-y-6">
            {/* Save Status Notices */}
            {saveStatus === 'saved' && (
              <Notice tone="success" eyebrow="Saved">
                <p className="mt-1 text-[13px] text-ink-700">
                  Interview saved successfully. View it in the researcher dashboard.
                </p>
              </Notice>
            )}
            {saveStatus === 'preview' && (
              <Notice tone="neutral" eyebrow="Preview">
                <p className="mt-1 text-[13px] text-ink-700">
                  Preview complete. This interview was not added to the study data.
                </p>
              </Notice>
            )}
            {saveStatus === 'failed' && (
              <Notice tone="error" eyebrow="Not saved">
                <p className="mt-1 text-[13px] text-ink-700">
                  Could not save interview. You can still export locally below.
                </p>
                <Button variant="quiet" disabled={isSaving} onClick={handleRetrySave} className="mt-2">
                  Retry Save
                </Button>
              </Notice>
            )}
            {saveStatus === 'pending' && isSaving && (
              <Notice tone="neutral" eyebrow="Saving">
                <p className="mt-1 text-[13px] text-ink-700">Saving interview...</p>
              </Notice>
            )}

            <SynthesisReading
              synthesis={synthesis}
              transcript={interviewHistory}
              openNotes={openNotes}
              onNoteOpenChange={setNoteOpen}
            />

            {/* Actions */}
            <div className="flex flex-col gap-3 pt-4 sm:flex-row">
              <Button variant="quiet" onClick={handleBack}>
                {viewMode === 'preview' ? 'Continue preview' : 'Continue Interview'}
              </Button>
              <Button variant="primary" onClick={handleExport}>
                {viewMode === 'preview' ? 'Export preview data' : 'Export Data'}
              </Button>
            </div>
          </div>
        ) : analysisError ? (
          <div>
            <h2 className="font-sans text-[18px] font-semibold text-ink-900">Analysis Failed</h2>
            <p className="mt-2 font-sans text-[15px] text-ink-700">
              There was an error analyzing the interview. Please try again.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button variant="quiet" onClick={handleBack}>
                Back to Interview
              </Button>
              <Button variant="primary" onClick={handleRetryAnalysis}>
                Retry Analysis
              </Button>
              {viewMode === 'preview' && (
                <Button variant="quiet" onClick={handleExport}>
                  Export transcript
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="font-sans text-[15px] text-ink-500">
              No interview data to analyze yet.
            </p>
            <Button variant="primary" onClick={handleBack} className="mt-4">
              Go to Interview
            </Button>
          </div>
        )}
      </Page>
    </main>
  );
};

export default Synthesis;
