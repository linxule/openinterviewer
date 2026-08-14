'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { synthesizeInterview } from '@/services/geminiService';
import { saveCompletedInterview } from '@/services/storageService';
import {
  Loader2,
  ArrowRight,
  ArrowLeft,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Target,
  BarChart3,
  CheckCircle,
  XCircle,
  RefreshCw
} from 'lucide-react';

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
    participantToken,
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
      }, participantToken, viewMode === 'preview', participantSessionHandle);

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
          participantToken,
          viewMode === 'preview',
          participantSessionHandle
        );
        setSynthesis(result);

        // Save interview to KV after synthesis completes
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
    // Note: behaviorData, participantProfile, participantToken are intentionally
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
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <p className="text-stone-400">No study configured.</p>
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
      <div className="min-h-screen bg-stone-900 p-4 sm:p-8 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-xl rounded-xl border border-stone-700 bg-stone-800/50 p-6 text-center sm:p-10"
        >
          {participantState === 'saved' ? (
            <>
              <div className="w-16 h-16 rounded-full bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                <CheckCircle size={32} className="text-green-400" />
              </div>
              <h1 className="text-2xl font-bold text-white mb-3">Interview submitted</h1>
              <p className="text-stone-300" role="status" aria-live="polite">
                Your responses have been saved. It is now safe to close this tab.
              </p>
            </>
          ) : participantState === 'analysis-failed' ? (
            <>
              <div className="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center mx-auto mb-4">
                <AlertTriangle size={32} className="text-red-400" />
              </div>
              <h1 className="text-2xl font-bold text-white mb-3">We couldn&apos;t finalize your interview</h1>
              <p className="text-stone-300 mb-6" role="alert">
                Your responses are still in this tab, but they have not been saved. Keep this tab open and try again.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                <button
                  onClick={handleBack}
                  className="px-6 py-3 border border-stone-600 text-stone-300 rounded-xl hover:bg-stone-700 transition-colors"
                >
                  Back to interview
                </button>
                <button
                  onClick={handleRetryAnalysis}
                  className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <RefreshCw size={18} />
                  Retry finalization
                </button>
              </div>
            </>
          ) : participantState === 'save-failed' ? (
            <>
              <div className="w-16 h-16 rounded-full bg-yellow-900/30 flex items-center justify-center mx-auto mb-4">
                <XCircle size={32} className="text-yellow-400" />
              </div>
              <h1 className="text-2xl font-bold text-white mb-3">We couldn&apos;t save your interview</h1>
              <p className="text-stone-300 mb-6" role="alert">
                Your responses are still in this tab. Keep it open and retry the save before closing.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                <button
                  onClick={handleBack}
                  className="px-6 py-3 border border-stone-600 text-stone-300 rounded-xl hover:bg-stone-700 transition-colors"
                >
                  Back to interview
                </button>
                <button
                  onClick={handleRetrySave}
                  disabled={isSaving}
                  className="px-6 py-3 bg-stone-600 hover:bg-stone-500 disabled:opacity-50 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {isSaving ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                  Retry save
                </button>
              </div>
            </>
          ) : (
            <>
              <Loader2 size={48} className="animate-spin text-stone-400 mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-white mb-3">Finalizing your interview</h1>
              <p className="text-stone-300" role="status" aria-live="polite">
                We are preparing and saving your responses. Keep this tab open until you see confirmation that it is safe to close.
              </p>
            </>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-900 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center">
              <BarChart3 className="text-stone-300" size={20} />
            </div>
            <h1 className="text-3xl font-bold text-white">
              {viewMode === 'preview' ? 'Researcher preview analysis' : 'Interview Analysis'}
            </h1>
          </div>
          <p className="text-stone-400 ml-13">
            Patterns and insights from the conversation
          </p>
        </motion.div>

        {isAnalyzing ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-stone-800/50 rounded-xl border border-stone-700 p-12 text-center"
          >
            <Loader2 size={48} className="animate-spin text-stone-400 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">
              Analyzing Interview...
            </h2>
            <p className="text-stone-400">
              Looking for patterns, themes, and insights
            </p>
          </motion.div>
        ) : synthesis ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Save Status Banner */}
            {saveStatus === 'saved' && (
              <div className="bg-green-900/30 border border-green-700 text-green-300 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle size={20} />
                <span>Interview saved successfully. View it in the researcher dashboard.</span>
              </div>
            )}
            {saveStatus === 'preview' && (
              <div className="bg-stone-800/50 border border-stone-600 text-stone-300 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle size={20} />
                <span>Preview complete. This interview was not added to the study data.</span>
              </div>
            )}
            {saveStatus === 'failed' && (
              <div className="bg-yellow-900/30 border border-yellow-700 text-yellow-300 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <XCircle size={20} />
                  <span>Could not save interview. You can still export locally below.</span>
                </div>
                <button
                  onClick={handleRetrySave}
                  disabled={isSaving}
                  className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-yellow-100 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Retry Save
                </button>
              </div>
            )}
            {saveStatus === 'pending' && isSaving && (
              <div className="bg-stone-800/50 border border-stone-600 text-stone-300 rounded-xl p-4 flex items-center gap-3">
                <Loader2 size={20} className="animate-spin" />
                <span>Saving interview...</span>
              </div>
            )}

            {/* Bottom Line */}
            <div className="bg-stone-700 text-white rounded-xl p-6">
              <div className="flex items-center gap-2 mb-2 text-stone-400">
                <Target size={18} />
                <span className="text-sm font-medium uppercase tracking-wider">
                  Key Insight
                </span>
              </div>
              <p className="text-xl font-medium">{synthesis.bottomLine}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Stated vs Revealed */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
                <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <TrendingUp size={18} className="text-stone-400" />
                  Stated vs Revealed
                </h3>

                <div className="space-y-4">
                  <div>
                    <div className="text-xs font-medium text-stone-500 uppercase mb-2">
                      What they said
                    </div>
                    <div className="space-y-1">
                      {synthesis.statedPreferences.map((item, i) => (
                        <div
                          key={i}
                          className="text-sm bg-stone-800 text-stone-300 px-3 py-1.5 rounded-lg"
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-stone-500 uppercase mb-2">
                      What their behavior revealed
                    </div>
                    <div className="space-y-1">
                      {synthesis.revealedPreferences.map((item, i) => (
                        <div
                          key={i}
                          className="text-sm bg-stone-700 text-stone-200 px-3 py-1.5 rounded-lg"
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Themes */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
                <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                  <Lightbulb size={18} className="text-stone-400" />
                  Key Themes
                </h3>

                <div className="space-y-3">
                  {synthesis.themes.map((theme, i) => (
                    <div key={i} className="border-b border-stone-700 pb-3 last:border-0">
                      <div className="font-medium text-stone-100">{theme.theme}</div>
                      <div className="text-sm text-stone-400 mt-1">{theme.evidence}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Contradictions */}
            {synthesis.contradictions.length > 0 && (
              <div className="bg-stone-800 border border-stone-600 rounded-xl p-6">
                <h3 className="font-semibold text-stone-200 mb-3 flex items-center gap-2">
                  <AlertTriangle size={18} className="text-stone-400" />
                  Potential Contradictions
                </h3>
                <ul className="space-y-2">
                  {synthesis.contradictions.map((c, i) => (
                    <li key={i} className="text-stone-300 text-sm">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Key Insights */}
            <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
              <h3 className="font-semibold text-white mb-4">
                Additional Insights
              </h3>
              <ul className="space-y-2">
                {synthesis.keyInsights.map((insight, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-stone-300"
                  >
                    <span className="text-stone-500 mt-1">-</span>
                    {insight}
                  </li>
                ))}
              </ul>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-4">
              <button
                onClick={handleBack}
                className="px-6 py-3 border border-stone-600 text-stone-400 rounded-xl hover:bg-stone-700 transition-colors flex items-center gap-2"
              >
                <ArrowLeft size={18} /> {viewMode === 'preview' ? 'Continue preview' : 'Continue Interview'}
              </button>
              <button
                onClick={handleExport}
                className="flex-1 py-3 bg-stone-600 hover:bg-stone-500 text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
              >
                {viewMode === 'preview' ? 'Export preview data' : 'Export Data'} <ArrowRight size={18} />
              </button>
            </div>
          </motion.div>
        ) : analysisError ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-stone-800/50 rounded-xl border border-stone-700 p-12 text-center"
          >
            <div className="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={32} className="text-red-400" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">
              Analysis Failed
            </h2>
            <p className="text-stone-400 mb-6">
              There was an error analyzing the interview. Please try again.
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleBack}
                className="px-6 py-3 border border-stone-600 text-stone-400 rounded-xl hover:bg-stone-700 transition-colors"
              >
                Back to Interview
              </button>
              <button
                onClick={handleRetryAnalysis}
                className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white font-medium rounded-xl transition-colors flex items-center gap-2"
              >
                <RefreshCw size={18} />
                Retry Analysis
              </button>
            </div>
          </motion.div>
        ) : (
          <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-12 text-center">
            <p className="text-stone-400">
              No interview data to analyze yet.
            </p>
            <button
              onClick={handleBack}
              className="mt-4 px-6 py-2 bg-stone-600 text-white rounded-lg"
            >
              Go to Interview
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Synthesis;
