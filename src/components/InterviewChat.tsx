'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import {
  generateInterviewResponse,
  getInterviewGreeting
} from '@/services/interviewApi';
import { InterviewMessage, InterviewPhase } from '@/types';
import ReactMarkdown from 'react-markdown';
import { Button, Turn } from '@/components/ui';

// Phase display labels
const phaseLabels: Record<InterviewPhase, string> = {
  'background': 'Getting to know you',
  'core-questions': 'Core Questions',
  'exploration': 'Exploring further',
  'feedback': 'Your feedback',
  'wrap-up': 'Wrapping up'
};

// Primitive props keep completed turns from reparsing Markdown when the
// composer changes or another message arrives.
const InterviewTurn = React.memo(function InterviewTurn({ role, content }: Pick<InterviewMessage, 'role' | 'content'>) {
  return (
    <Turn speaker={role === 'ai' ? 'interviewer' : 'participant'}>
      <span className="sr-only">{role === 'ai' ? 'Interviewer:' : 'You:'} </span>
      <div className="prose-verbatim">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </Turn>
  );
});

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
    participantSessionHandle,
    viewMode
  } = useStore();

  const [input, setInput] = useState('');
  const [showFinishOption, setShowFinishOption] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);
  const greetingStartedRef = useRef(false);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The participant may scroll up to re-read an earlier answer. Auto-scroll is
  // for people already at the live edge; it must never move the page under
  // someone who is reading. 120px ≈ four lines of body leading.
  useEffect(() => {
    const updatePin = () => {
      const remaining =
        document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
      stickToBottomRef.current = remaining <= 120;
    };
    updatePin();
    window.addEventListener('scroll', updatePin, { passive: true });
    return () => window.removeEventListener('scroll', updatePin);
  }, []);

  // Scroll to bottom on new messages, but only when the participant is at the
  // live edge, and instantly under prefers-reduced-motion.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const reduced =
      typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messagesEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'end' });
  }, [interviewHistory, isAiThinking]);

  // Show finish option after background phase
  useEffect(() => {
    if (questionProgress.currentPhase !== 'background') {
      setShowFinishOption(true);
    }
  }, [questionProgress.currentPhase]);

  // Autogrow fallback: `.input-verbatim` sets `field-sizing: content` for
  // browsers that support it. Where that's unsupported, size the textarea
  // from its scrollHeight instead, clamped to the same ~40vh cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const supportsFieldSizing =
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
    if (supportsFieldSizing) return;

    const resize = () => {
      el.style.height = 'auto';
      const maxHeight = window.innerHeight * 0.4;
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [input]);

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
  }, [studyConfig, interviewHistory.length, participantSessionHandle, viewMode, addMessage, setAiThinking]);

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
    stickToBottomRef.current = true;
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

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter alone inserts a newline (default textarea behavior). Only
    // Cmd/Ctrl+Enter sends; the Send button is the other way to send.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!isAiThinking && input.trim()) {
        void handleSend();
      }
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
      <div className="flex min-h-dvh items-center justify-center bg-paper-0">
        <p className="text-ink-500">No study configured.</p>
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
    <div className="min-h-dvh bg-paper-0">
      {/* Running head */}
      <header className="sticky top-[var(--preview-banner-height,0px)] z-20 flex min-h-16 items-center justify-between gap-3 border-b border-ink-300 bg-paper-0 px-4 py-2 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-sans text-[15px] font-semibold text-ink-900">{studyConfig.name}</h1>
          <p className="text-[13px] text-ink-500">{getProgressDisplay()}</p>
        </div>

        {showFinishOption && !isComplete && (
          <button
            type="button"
            onClick={handleFinishEarly}
            className="shrink-0 text-[13px] text-ink-500 underline-offset-2 hover:text-ink-700 hover:underline"
          >
            Finish early
          </button>
        )}
      </header>

      <main>
        {/* Transcript */}
        {/* `relative` keeps the absolutely-positioned sr-only speaker prefixes inside
            a positioned ancestor — without it they resolve against the initial
            containing block and can inflate the document's scroll height, which
            now is the page's scroll height. */}
        <div role="log" aria-live="polite" className="relative">
          <div className="mx-auto max-w-measure space-y-8 px-4 py-8">
            {interviewHistory.map((msg) => (
              <InterviewTurn key={msg.id} role={msg.role} content={msg.content} />
            ))}

            {isAiThinking && (
              <div role="status">
                <div className="h-[2px] overflow-hidden">
                  <div className="composing-bar h-full bg-ink-300" />
                </div>
                <p className="mt-2 text-[13px] text-ink-500">Composing a follow-up…</p>
              </div>
            )}
          </div>
        </div>

        {/* Input Area or Completion UI */}
        {isComplete ? (
          <div className="border-t border-ink-300 px-4 py-8 sm:px-6">
            <div className="mx-auto max-w-measure space-y-4">
              <h3 className="font-sans text-[18px] leading-[26px] font-semibold text-ink-900">
                {viewMode === 'preview' ? 'Preview conversation complete' : 'Interview conversation complete'}
              </h3>
              <p className="font-sans text-[15px] leading-[24px] text-ink-700">
                {viewMode === 'preview'
                  ? 'Continue to generate the preview analysis. Preview responses will not be added to study data.'
                  : 'Your responses have not been saved yet. Continue to finalize and save your interview. Keep this tab open until you see confirmation that it is safe to close.'}
              </p>
              <Button type="button" variant="primary" onClick={handleViewAnalysis}>
                {viewMode === 'preview' ? 'Continue preview' : 'Continue to save interview'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="sticky bottom-0 z-10 border-t border-ink-300 bg-paper-0 px-4 py-4 sm:px-6">
            <div className="mx-auto max-w-measure space-y-2 pl-8">
              {(initError || sendError) && (
                <div
                  role="alert"
                  className="flex items-start justify-between gap-3 bg-error px-4 py-3 font-sans text-[15px] leading-[24px] text-paper-1"
                >
                  <p>{initError || sendError}</p>
                  {initError && (
                    <button
                      type="button"
                      onClick={handleRetryGreeting}
                      disabled={isAiThinking}
                      className="shrink-0 text-paper-1 underline underline-offset-2 hover:opacity-90 disabled:opacity-50"
                    >
                      Try again
                    </button>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
                <div className="flex-1">
                  <label htmlFor="interview-response" className="sr-only">
                    Your response
                  </label>
                  <textarea
                    ref={textareaRef}
                    id="interview-response"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleTextareaKeyDown}
                    placeholder="Take as much space as you need."
                    disabled={isAiThinking}
                    rows={3}
                    className="input-verbatim w-full resize-none rounded border border-ink-300 bg-paper-2 px-4 py-3 text-[19px] leading-[31px] text-ink-900 placeholder:text-ink-500 disabled:opacity-50"
                  />
                </div>

                <Button
                  type="button"
                  variant="primary"
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isAiThinking}
                  className="min-h-11 w-full sm:w-auto"
                >
                  Send
                </Button>
              </div>
              <p className="text-[13px] leading-[20px] text-ink-500 [@media(pointer:coarse)]:hidden">⌘/Ctrl + Enter to send</p>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>
    </div>
  );
};

export default InterviewChat;
