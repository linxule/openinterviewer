'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '@/store';
import {
  generateInterviewResponse,
  getInterviewGreeting
} from '@/services/geminiService';
import { InterviewMessage, InterviewPhase } from '@/types';
import ReactMarkdown from 'react-markdown';
import {
  Send,
  Loader2,
  Bot,
  ArrowRight,
  MessageSquare,
  CheckCircle,
  User
} from 'lucide-react';

// Phase display labels
const phaseLabels: Record<InterviewPhase, string> = {
  'background': 'Getting to know you',
  'core-questions': 'Core Questions',
  'exploration': 'Exploring further',
  'feedback': 'Your feedback',
  'wrap-up': 'Wrapping up'
};

const InterviewChat: React.FC = () => {
  const router = useRouter();
  const {
    studyConfig,
    participantProfile,
    questionProgress,
    interviewHistory,
    addMessage,
    setStep,
    isAiThinking,
    setAiThinking,
    contextEntries,
    appendContext,
    setInterviewPhase,
    markQuestionAsked,
    completeInterview,
    updateProfileField,
    setProfileRawContext,
    participantToken,
    participantSessionHandle,
    viewMode
  } = useStore();

  const [input, setInput] = useState('');
  const [showFinishOption, setShowFinishOption] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const greetingStartedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [interviewHistory, isAiThinking]);

  // Show finish option after background phase
  useEffect(() => {
    if (questionProgress.currentPhase !== 'background') {
      setShowFinishOption(true);
    }
  }, [questionProgress.currentPhase]);

  // Initialize with greeting. The started ref must live outside this effect so a
  // re-run (history length, config identity) cannot cancel an in-flight request
  // and leave Thinking stuck.
  useEffect(() => {
    if (!studyConfig || greetingStartedRef.current || interviewHistory.length > 0) {
      return;
    }

    greetingStartedRef.current = true;
    setInitError(null);
    setAiThinking(true);

    const initialize = async () => {
      try {
        const greeting = await getInterviewGreeting(
          studyConfig,
          participantToken,
          viewMode === 'preview',
          participantSessionHandle
        );
        if (!mountedRef.current) return;

        const msg: InterviewMessage = {
          id: `msg-${Date.now()}`,
          role: 'ai',
          content: greeting,
          timestamp: Date.now()
        };
        addMessage(msg);
      } catch (error) {
        console.error('Error initializing interview:', error);
        if (!mountedRef.current) return;
        greetingStartedRef.current = false;
        setInitError('The interviewer could not start. This is not an AI reply — please try again.');
      } finally {
        if (mountedRef.current) setAiThinking(false);
      }
    };

    void initialize();
  }, [studyConfig, interviewHistory.length, participantToken, participantSessionHandle, viewMode, addMessage, setAiThinking]);

  const handleSend = async (textOverride?: string) => {
    const text = textOverride || input;
    if (!text.trim() || !studyConfig) return;

    // Add user message
    const userMsg: InterviewMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    addMessage(userMsg);
    setInput('');
    setSendError(null);

    // Also save to context
    appendContext(text, 'text');

    // Generate AI response
    setAiThinking(true);

    try {
      const currentContext = contextEntries.map(e => e.text).join('\n');
      const updatedHistory = [...interviewHistory, userMsg];

      const response = await generateInterviewResponse(
        updatedHistory,
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
        participantToken,
        viewMode === 'preview',
        participantSessionHandle
      );

      if (!mountedRef.current) return;

      // Handle profile updates
      if (response.profileUpdates && response.profileUpdates.length > 0) {
        response.profileUpdates.forEach(update => {
          updateProfileField(update.fieldId, update.value, update.status);
        });

        // Update raw context with user's background info
        if (questionProgress.currentPhase === 'background') {
          const existingContext = participantProfile?.rawContext || '';
          const newContext = existingContext + (existingContext ? '\n' : '') + text;
          setProfileRawContext(newContext);
        }
      }

      // Handle phase transition
      if (response.phaseTransition) {
        setInterviewPhase(response.phaseTransition);
      }

      // Handle question progress
      if (response.questionAddressed !== null && response.questionAddressed !== undefined) {
        markQuestionAsked(response.questionAddressed);
      }

      // Add AI message
      const aiMsg: InterviewMessage = {
        id: `msg-${Date.now()}`,
        role: 'ai',
        content: response.message,
        timestamp: Date.now()
      };
      addMessage(aiMsg);

      // Handle interview conclusion
      if (response.shouldConclude) {
        completeInterview();
      }
    } catch (error) {
      console.error('Error generating response:', error);
      if (!mountedRef.current) return;
      setSendError('The interviewer could not reply. Please try sending again.');
    } finally {
      if (mountedRef.current) setAiThinking(false);
    }
  };

  const handleRetryGreeting = () => {
    if (!studyConfig || isAiThinking || interviewHistory.length > 0) return;
    greetingStartedRef.current = false;
    setInitError(null);
    greetingStartedRef.current = true;
    setAiThinking(true);
    void (async () => {
      try {
        const greeting = await getInterviewGreeting(
          studyConfig,
          participantToken,
          viewMode === 'preview',
          participantSessionHandle
        );
        if (!mountedRef.current) return;
        addMessage({
          id: `msg-${Date.now()}`,
          role: 'ai',
          content: greeting,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('Error initializing interview:', error);
        if (!mountedRef.current) return;
        greetingStartedRef.current = false;
        setInitError('The interviewer could not start. This is not an AI reply — please try again.');
      } finally {
        if (mountedRef.current) setAiThinking(false);
      }
    })();
  };

  const handleFinishEarly = () => {
    completeInterview();
  };

  const handleViewAnalysis = () => {
    setStep('synthesis');
    router.push('/synthesis');
  };

  if (!studyConfig) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <p className="text-stone-400">No study configured.</p>
      </div>
    );
  }

  // Calculate progress
  const totalQuestions = studyConfig.coreQuestions.length;
  const questionsCompleted = questionProgress.questionsAsked.length;
  const isComplete = questionProgress.isComplete;

  // Progress display
  const getProgressDisplay = () => {
    if (questionProgress.currentPhase === 'background') {
      return phaseLabels['background'];
    }
    if (questionProgress.currentPhase === 'core-questions') {
      return `Question ${Math.min(questionsCompleted + 1, totalQuestions)} of ${totalQuestions}`;
    }
    return phaseLabels[questionProgress.currentPhase];
  };

  return (
    <div className="flex flex-col h-screen bg-stone-900">
      {/* Header with Progress */}
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-stone-700 bg-stone-900/80 px-4 py-2 backdrop-blur-md sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-700">
            <MessageSquare size={16} className="text-stone-300" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-semibold text-white">{studyConfig.name}</h1>
            <p className="text-xs text-stone-500">{getProgressDisplay()}</p>
          </div>
        </div>

        {/* Progress Dots */}
        <div className="flex shrink-0 items-center gap-4">
          <div className="hidden items-center gap-1.5 sm:flex" aria-hidden="true">
            {Array.from({ length: totalQuestions }).map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-colors ${
                  questionProgress.questionsAsked.includes(i)
                    ? 'bg-stone-400'
                    : 'bg-stone-700'
                }`}
              />
            ))}
          </div>

          {/* Subtle finish early option */}
          {showFinishOption && !isComplete && (
            <button
              onClick={handleFinishEarly}
              className="text-xs text-stone-500 hover:text-stone-400 transition-colors"
            >
              Finish early
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 bg-stone-900 p-4 sm:p-6">
        <AnimatePresence>
          {interviewHistory.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl p-4 ${
                  msg.role === 'user'
                    ? 'bg-stone-700 text-white rounded-br-md'
                    : 'bg-stone-800 border border-stone-700 text-stone-100 rounded-bl-md'
                }`}
              >
                {msg.role === 'ai' && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-stone-500">
                    <Bot size={14} />
                    Interviewer
                  </div>
                )}
                {msg.role === 'user' && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-stone-400 justify-end">
                    You
                    <User size={14} />
                  </div>
                )}
                <div className={`prose prose-sm max-w-none prose-invert`}>
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Thinking indicator */}
        {isAiThinking && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex justify-start"
          >
            <div className="bg-stone-800 border border-stone-700 rounded-2xl rounded-bl-md p-4">
              <div className="flex items-center gap-2 text-stone-400 text-sm">
                <Loader2 size={16} className="animate-spin" />
                Thinking...
              </div>
            </div>
          </motion.div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area or Completion UI */}
      {isComplete ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-6 bg-stone-800 border-t border-stone-700"
        >
          <div className="max-w-md mx-auto text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-stone-700 flex items-center justify-center mx-auto">
              <CheckCircle size={24} className="text-stone-300" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">
                {viewMode === 'preview' ? 'Preview conversation complete' : 'Interview conversation complete'}
              </h3>
              <p className="text-sm text-stone-400 mt-1">
                {viewMode === 'preview'
                  ? 'Continue to generate the preview analysis. Preview responses will not be added to study data.'
                  : 'Your responses have not been saved yet. Continue to finalize and save your interview. Keep this tab open until you see confirmation that it is safe to close.'}
              </p>
            </div>
            <button
              onClick={handleViewAnalysis}
              className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white font-medium rounded-xl transition-colors flex items-center gap-2 mx-auto"
            >
              {viewMode === 'preview' ? 'Continue preview' : 'Continue to save interview'}
              <ArrowRight size={18} />
            </button>
          </div>
        </motion.div>
      ) : (
        <div className="p-4 bg-stone-800 border-t border-stone-700">
          <div className="max-w-3xl mx-auto space-y-3">
            {(initError || sendError) && (
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-xl border border-red-700/50 bg-red-900/30 px-4 py-3 text-sm text-red-200"
              >
                <p>{initError || sendError}</p>
                {initError && (
                  <button
                    type="button"
                    onClick={handleRetryGreeting}
                    disabled={isAiThinking}
                    className="shrink-0 text-red-100 underline underline-offset-2 hover:text-white disabled:opacity-50"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
            <div className="flex gap-3">
              <label htmlFor="interview-response" className="sr-only">
                Your response
              </label>
              <input
                id="interview-response"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isAiThinking && handleSend()}
                placeholder="Type your response..."
                disabled={isAiThinking}
                className="flex-1 px-4 py-3 bg-stone-900 border border-stone-600 text-stone-100 placeholder-stone-500 rounded-xl focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 disabled:opacity-50"
              />

              <button
                type="button"
                aria-label="Send response"
                onClick={() => handleSend()}
                disabled={!input.trim() || isAiThinking}
                className="p-3 bg-stone-600 hover:bg-stone-500 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={20} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InterviewChat;
