'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { synthesizeInterview } from '@/services/interviewApi';
import { saveCompletedInterview } from '@/services/storageService';
import { Button, Label, Page, Rule, Verbatim } from '@/components/ui';

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
    viewMode
  } = useStore();

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'pending' | 'saved' | 'preview' | 'failed' | null>(null);
  const [analysisError, setAnalysisError] = useState(false);

  // Track if analysis has been attempted to prevent re-running
  const hasAttemptedAnalysis = useRef(false);

  // Counter to trigger re-analysis when retry is clicked
  const [retryTrigger, setRetryTrigger] = useState(0);

  // Extract save logic into a reusable function for retry
  const doSave = async (synthesisToSave: typeof synthesis) => {
    if (!studyConfig || !synthesisToSave) return;

    setIsSaving(true);
    setSaveStatus('pending');
    try {
      const interviewId = participantProfile?.id || `interview-${Date.now()}`;
      const saveResult = await saveCompletedInterview({
        id: interviewId,
        studyId: studyConfig.id,
        studyName: studyConfig.name,
        participantProfile: participantProfile || {
          id: interviewId,
          fields: [],
          rawContext: '',
          timestamp: Date.now()
        },
        transcript: interviewHistory,
        synthesis: synthesisToSave,
        behaviorData: behaviorData,
        createdAt: participantProfile?.timestamp || Date.now()
      }, viewMode === 'preview', participantSessionHandle);

      setSaveStatus(saveResult.preview ? 'preview' : saveResult.success ? 'saved' : 'failed');
    } catch (error) {
      console.error('Error saving interview:', error);
      setSaveStatus('failed');
    } finally {
      setIsSaving(false);
    }
  };

  // Retry save handler
  const handleRetrySave = () => {
    if (synthesis) {
      doSave(synthesis);
    }
  };

  // Retry analysis handler (for when synthesis itself fails)
  const handleRetryAnalysis = () => {
    setAnalysisError(false);
    hasAttemptedAnalysis.current = false;
    setRetryTrigger(prev => prev + 1);  // Trigger effect re-run
  };

  useEffect(() => {
    const analyzeAndSave = async () => {
      if (!studyConfig || interviewHistory.length === 0) return;

      // If we already have synthesis, try to save if not already saved
      if (synthesis) {
        if (saveStatus === null && !hasAttemptedAnalysis.current) {
          // Page was refreshed with synthesis in store but save never attempted
          hasAttemptedAnalysis.current = true;
          doSave(synthesis);
        }
        return;
      }

      // Prevent re-running analysis if already attempted
      if (hasAttemptedAnalysis.current) return;
      hasAttemptedAnalysis.current = true;

      setIsAnalyzing(true);
      try {
        const result = await synthesizeInterview(
          interviewHistory,
          studyConfig,
          behaviorData,
          participantProfile,
          viewMode === 'preview',
          participantSessionHandle
        );
        setSynthesis(result);

        // Save the interview to Upstash Redis after synthesis completes.
        await doSave(result);
      } catch (error) {
        console.error('Error synthesizing interview:', error);
        setAnalysisError(true);
        hasAttemptedAnalysis.current = false;  // Allow retry
      } finally {
        setIsAnalyzing(false);
      }
    };

    analyzeAndSave();
    // Note: behaviorData and participantProfile are intentionally
    // not in deps - we only want to analyze once when the page loads, not on updates
    // retryTrigger is included to allow manual retry after failure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyConfig, interviewHistory, synthesis, saveStatus, setSynthesis, retryTrigger]);

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
            </>
          ) : participantState === 'analysis-failed' ? (
            <>
              <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
                We couldn&apos;t finalize your interview
              </Verbatim>
              <div className="border-l-2 border-error bg-paper-2 px-4 py-3">
                <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="alert">
                  Your responses are still in this tab, but they have not been saved. Keep this tab open and try again.
                </p>
              </div>
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
              <div className="border-l-2 border-error bg-paper-2 px-4 py-3">
                <p className="font-sans text-[15px] leading-[24px] text-ink-700" role="alert">
                  Your responses are still in this tab. Keep it open and retry the save before closing.
                </p>
              </div>
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
              <div className="border-l-2 border-success bg-paper-2 px-4 py-3">
                <Label>Saved</Label>
                <p className="mt-1 text-[13px] text-ink-700">
                  Interview saved successfully. View it in the researcher dashboard.
                </p>
              </div>
            )}
            {saveStatus === 'preview' && (
              <div className="border-l-2 border-ink-500 bg-paper-2 px-4 py-3">
                <Label>Preview</Label>
                <p className="mt-1 text-[13px] text-ink-700">
                  Preview complete. This interview was not added to the study data.
                </p>
              </div>
            )}
            {saveStatus === 'failed' && (
              <div className="border-l-2 border-error bg-paper-2 px-4 py-3">
                <Label>Not saved</Label>
                <p className="mt-1 text-[13px] text-ink-700">
                  Could not save interview. You can still export locally below.
                </p>
                <Button variant="quiet" disabled={isSaving} onClick={handleRetrySave} className="mt-2">
                  Retry Save
                </Button>
              </div>
            )}
            {saveStatus === 'pending' && isSaving && (
              <div className="border-l-2 border-ink-500 bg-paper-2 px-4 py-3">
                <Label>Saving</Label>
                <p className="mt-1 text-[13px] text-ink-700">Saving interview...</p>
              </div>
            )}

            {/* Bottom line */}
            <section>
              <Label className="block">Bottom line</Label>
              <Verbatim
                as="p"
                className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]"
              >
                {synthesis.bottomLine}
              </Verbatim>
            </section>
            <Rule className="mt-8" />

            {/* Stated vs Revealed */}
            <section>
              <h3 className="font-sans text-[15px] font-semibold text-ink-900">Stated vs Revealed</h3>
              <div className="mt-4 md:grid md:grid-cols-2 md:gap-10">
                <div>
                  <Label>What they said</Label>
                  <ul>
                    {synthesis.statedPreferences.map((item, i) => (
                      <li
                        key={i}
                        className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-6 md:mt-0">
                  <Label>What their behavior revealed</Label>
                  <ul>
                    {synthesis.revealedPreferences.map((item, i) => (
                      <li
                        key={i}
                        className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
            <Rule className="mt-8" />

            {/* Key Themes */}
            <section>
              <h3 className="font-sans text-[15px] font-semibold text-ink-900">Key Themes</h3>
              <ul className="mt-4">
                {synthesis.themes.map((theme, i) => (
                  <li key={i} className="border-t border-ink-300 py-4">
                    <p className="font-sans text-[15px] font-medium text-ink-900">{theme.theme}</p>
                    <Verbatim
                      as="p"
                      className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                    >
                      {theme.evidence}
                    </Verbatim>
                  </li>
                ))}
              </ul>
            </section>

            {/* Contradictions */}
            {synthesis.contradictions.length > 0 && (
              <section className="border-t border-ink-300 pt-5">
                <h3 className="font-sans text-[15px] font-semibold text-ink-900">Potential Contradictions</h3>
                <ul className="mt-3 space-y-2">
                  {synthesis.contradictions.map((c, i) => (
                    <li key={i} className="max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                      {c}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Additional Insights */}
            <section>
              <h3 className="font-sans text-[15px] font-semibold text-ink-900">Additional Insights</h3>
              <ul className="mt-4">
                {synthesis.keyInsights.map((insight, i) => (
                  <li
                    key={i}
                    className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                  >
                    {insight}
                  </li>
                ))}
              </ul>
            </section>

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
            <div className="mt-6 flex gap-3">
              <Button variant="quiet" onClick={handleBack}>
                Back to Interview
              </Button>
              <Button variant="primary" onClick={handleRetryAnalysis}>
                Retry Analysis
              </Button>
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
