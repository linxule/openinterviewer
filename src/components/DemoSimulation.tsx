'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Lightbulb,
  Quote,
  RotateCcw,
  Search,
  ShieldCheck,
  Target,
  User,
} from 'lucide-react';

type DemoPath = 'project' | 'recommendation' | 'curiosity';
type DemoView = 'intro' | 'interview' | 'insight';

interface DemoChoice {
  id: string;
  text: string;
  path?: DemoPath;
}

interface DemoBranch {
  label: string;
  followUp: string;
  secondChoices: DemoChoice[];
  deepProbe: string;
  thirdChoices: DemoChoice[];
  theme: string;
  bottomLine: string;
  interpretation: string;
  hypothesis: string;
  nuance: string;
}

interface TranscriptMessage {
  id: string;
  role: 'interviewer' | 'participant';
  content: string;
  evidence?: boolean;
}

const STUDY_NAME = 'Reading lists people actually return to';
const RESEARCH_QUESTION = 'Why do people save articles they intend to read but rarely revisit?';
const OPENING_QUESTION =
  'Think about the last article you saved but did not finish. What made you save it?';
const CLOSING_MESSAGE =
  'That distinction is useful. In a real study, the researcher would compare this account with other interviews. Let us switch views and inspect the note this fictional path produces.';

const FIRST_CHOICES: DemoChoice[] = [
  {
    id: 'project',
    path: 'project',
    text: 'It looked useful for a work project, but I did not have time then.',
  },
  {
    id: 'recommendation',
    path: 'recommendation',
    text: 'A colleague I trust said it changed how they thought about the topic.',
  },
  {
    id: 'curiosity',
    path: 'curiosity',
    text: 'The headline made me curious, but I was not ready to give it twenty minutes.',
  },
];

const BRANCHES: Record<DemoPath, DemoBranch> = {
  project: {
    label: 'Project context',
    followUp:
      'You saved it for a specific future use. When you came back, what got in the way?',
    secondChoices: [
      {
        id: 'project-context-lost',
        text: 'I had forgotten which project it was for, so opening it felt like work before the reading even started.',
      },
      {
        id: 'project-moved-on',
        text: 'I could not remember why I had saved it, and by then the project had moved on, so it felt obsolete.',
      },
    ],
    deepProbe:
      'The reason for saving had faded. If the tool could preserve one thing from that moment, what would help most?',
    thirdChoices: [
      {
        id: 'project-own-note',
        text: 'A one-line note in my own words: why it mattered and what I hoped to use it for.',
      },
      {
        id: 'project-question',
        text: 'The project name and the question I was trying to answer when I saved it.',
      },
    ],
    theme: 'Lost context creates re-entry work',
    bottomLine:
      'Returning fails when the reason for saving is lost; preserving intent may matter more than sending another reminder.',
    interpretation:
      'Reconstructing purpose becomes part of the cost of reading, so the saved item feels like unfinished administrative work.',
    hypothesis:
      'Capture a short statement of intended use at save time, then restore it when the reader chooses to return.',
    nuance:
      'The participant is not asking the product to create urgency. They want context available at the moment of re-entry.',
  },
  recommendation: {
    label: 'Borrowed relevance',
    followUp:
      'The recommendation carried someone else’s judgment. What changed when you returned without them there?',
    secondChoices: [
      {
        id: 'recommendation-why',
        text: 'I remembered that they valued it, but not why they thought it mattered to me.',
      },
      {
        id: 'recommendation-obligation',
        text: 'I could not remember why they thought it fit me, so it felt like an obligation rather than my own choice.',
      },
    ],
    deepProbe:
      'The social reason stayed, but the personal reason weakened. What would help you decide whether it still deserves attention?',
    thirdChoices: [
      {
        id: 'recommendation-specific-note',
        text: 'A note from them about the specific idea they wanted me to notice.',
      },
      {
        id: 'recommendation-dismiss',
        text: 'A quick way to say “not for me” without leaving it in the queue forever.',
      },
    ],
    theme: 'Borrowed relevance decays without a reason',
    bottomLine:
      'A trusted recommendation gets an article saved, but not necessarily read; the missing ingredient is why it mattered to this reader.',
    interpretation:
      'Social trust creates initial relevance, while an unexplained recommendation can later feel like an obligation rather than a choice.',
    hypothesis:
      'Preserve the recommender’s rationale and offer a graceful way to dismiss items that no longer feel personally relevant.',
    nuance:
      'The participant values the colleague’s judgment but resists turning that relationship into a permanent reading debt.',
  },
  curiosity: {
    label: 'Fading curiosity',
    followUp:
      'Curiosity was enough to save it, but not enough to read it. What happened when you saw it again?',
    secondChoices: [
      {
        id: 'curiosity-moment-passed',
        text: 'I could not remember the question that made the headline interesting once the original moment had passed.',
      },
      {
        id: 'curiosity-crowded-list',
        text: 'I had dozens of saved pieces, and nothing told me why this one had mattered.',
      },
    ],
    deepProbe:
      'The list kept the article but not the question behind it. What would make resurfacing feel useful instead of like backlog?',
    thirdChoices: [
      {
        id: 'curiosity-original-question',
        text: 'Show me the question I had when I saved it, not just the title.',
      },
      {
        id: 'curiosity-expire',
        text: 'Let older items quietly expire instead of asking me to clear them one by one.',
      },
    ],
    theme: 'Saved curiosity becomes undifferentiated backlog',
    bottomLine:
      'A reading list preserves the object but loses the question that made it interesting, so curiosity turns into maintenance.',
    interpretation:
      'The participant does not need more resurfacing; they need the original spark restored or permission for the item to disappear.',
    hypothesis:
      'Save the reader’s question alongside the article and allow low-intent items to decay without demanding inbox-style cleanup.',
    nuance:
      'More reminders could increase guilt while doing nothing to recover the curiosity that prompted the save.',
  },
};

function buildTranscript(answers: string[], path: DemoPath | null): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [
    {
      id: 'opening',
      role: 'interviewer',
      content: OPENING_QUESTION,
    },
  ];

  if (!path) return messages;

  const branch = BRANCHES[path];
  const interviewerReplies = [branch.followUp, branch.deepProbe, CLOSING_MESSAGE];

  answers.forEach((answer, index) => {
    messages.push({
      id: `participant-${index + 1}`,
      role: 'participant',
      content: answer,
      evidence: index === 1,
    });
    messages.push({
      id: `interviewer-${index + 2}`,
      role: 'interviewer',
      content: interviewerReplies[index],
    });
  });

  return messages;
}

const DemoSimulation: React.FC = () => {
  const [view, setView] = useState<DemoView>('intro');
  const [path, setPath] = useState<DemoPath | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [highlightEvidence, setHighlightEvidence] = useState(false);
  const [hasSeenInsight, setHasSeenInsight] = useState(false);
  const choiceGroupRef = useRef<HTMLFieldSetElement>(null);
  const completionButtonRef = useRef<HTMLButtonElement>(null);
  const insightHeadingRef = useRef<HTMLHeadingElement>(null);
  const evidenceRef = useRef<HTMLLIElement>(null);

  const branch = path ? BRANCHES[path] : null;
  const transcript = buildTranscript(answers, path);
  const interviewComplete = answers.length === 3;

  let choices: DemoChoice[] = FIRST_CHOICES;
  if (branch && answers.length === 1) choices = branch.secondChoices;
  if (branch && answers.length === 2) choices = branch.thirdChoices;
  if (interviewComplete) choices = [];

  useEffect(() => {
    if (view === 'insight') {
      insightHeadingRef.current?.focus();
      return;
    }
    if (view === 'interview' && highlightEvidence) {
      evidenceRef.current?.focus();
      return;
    }
    if (view === 'interview' && interviewComplete) {
      completionButtonRef.current?.focus();
      return;
    }
    if (view === 'interview' && !interviewComplete) {
      choiceGroupRef.current?.focus();
    }
  }, [answers.length, highlightEvidence, interviewComplete, view]);

  const resetTo = (nextView: DemoView) => {
    setPath(null);
    setAnswers([]);
    setHighlightEvidence(false);
    setHasSeenInsight(false);
    setView(nextView);
  };

  const handleChoice = (choice: DemoChoice) => {
    if (answers.length === 0) {
      if (!choice.path) return;
      setPath(choice.path);
    }
    setHighlightEvidence(false);
    setAnswers((current) => [...current, choice.text]);
  };

  const showInsight = () => {
    setHasSeenInsight(true);
    setHighlightEvidence(false);
    setView('insight');
  };

  const traceEvidence = () => {
    setHighlightEvidence(true);
    setView('interview');
  };

  return (
    <div className="min-h-dvh bg-stone-900 text-stone-100">
      <aside
        aria-label="Demo disclosure"
        className="border-b border-amber-700/40 bg-amber-950/40"
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-amber-200" size={20} />
            <div>
              <p className="font-semibold text-amber-100">Scripted demo</p>
              <p className="text-sm text-amber-100/85">
                Maya is fictional. Every response, follow-up, and insight is pre-written. No demo response leaves this page or survives a refresh.
              </p>
            </div>
          </div>
          <nav aria-label="Demo links" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <Link href="/login" className="text-amber-100 underline underline-offset-4 hover:text-white">
              Configured workspace
            </Link>
            <Link href="/self-host" className="text-amber-100 underline underline-offset-4 hover:text-white">
              Self-host setup
            </Link>
          </nav>
        </div>
      </aside>

      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        {view === 'intro' && (
          <div className="space-y-8">
            <div className="grid items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-400">
                  Participant view → researcher view
                </p>
                <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
                  See an interview become an insight.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-stone-300">
                  Choose Maya’s fictional replies in a two-minute walkthrough. Watch the interviewer follow her thread, then inspect the evidence behind the researcher note.
                </p>
                <button
                  type="button"
                  data-testid="demo-start"
                  onClick={() => setView('interview')}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-stone-100 px-5 py-3 font-semibold text-stone-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900"
                >
                  Begin scripted interview
                  <ArrowRight aria-hidden="true" size={18} />
                </button>
              </div>

              <section aria-labelledby="demo-study-heading" className="rounded-2xl border border-stone-700 bg-stone-800/70 p-5 sm:p-6">
                <div className="mb-4 flex items-center gap-2 text-stone-300">
                  <BookOpen aria-hidden="true" size={18} />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">Synthetic study</span>
                </div>
                <h2 id="demo-study-heading" className="text-xl font-semibold text-white">{STUDY_NAME}</h2>
                <p className="mt-4 text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">Research question</p>
                <p className="mt-2 leading-7 text-stone-200">{RESEARCH_QUESTION}</p>
              </section>
            </div>

            <ol aria-label="Demo workflow" className="grid gap-3 sm:grid-cols-3">
              {[
                ['1', 'Recall a moment', 'Begin with a concrete experience, not an abstract opinion.'],
                ['2', 'Follow the thread', 'Probe what the participant means instead of reading the next fixed question.'],
                ['3', 'Trace the insight', 'Keep interpretation beside the exact transcript evidence that supports it.'],
              ].map(([number, title, description]) => (
                <li key={number} className="rounded-2xl border border-stone-800 bg-stone-850 p-5">
                  <span className="text-sm font-semibold text-amber-200">{number}</span>
                  <h3 className="mt-2 font-semibold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-400">{description}</p>
                </li>
              ))}
            </ol>
          </div>
        )}

        {view === 'interview' && (
          <div className="space-y-6">
            <header className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-stone-400">Synthetic study</p>
                <button
                  type="button"
                  onClick={() => resetTo('intro')}
                  className="text-sm text-stone-300 underline underline-offset-4 hover:text-white"
                >
                  Back to overview
                </button>
              </div>
              <h1 className="text-3xl font-bold text-white sm:text-4xl">{STUDY_NAME}</h1>
              <p className="max-w-3xl text-stone-300">
                <span className="font-medium text-stone-100">Research question:</span> {RESEARCH_QUESTION}
              </p>
            </header>

            <div
              role="status"
              data-testid="demo-progress"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-700 bg-stone-800/60 px-4 py-3 text-sm"
            >
              <span className="font-medium text-stone-200">
                {interviewComplete ? 'Interview complete' : `Question ${answers.length + 1} of 3`}
              </span>
              <span className="text-stone-400">
                {branch ? `Scripted branch: ${branch.label}` : 'Choose the opening path'}
              </span>
            </div>

            <section aria-labelledby="transcript-heading" className="rounded-2xl border border-stone-700 bg-stone-850 p-4 sm:p-6">
              <h2 id="transcript-heading" className="sr-only">Scripted interview transcript</h2>
              <div role="log" aria-live="polite" aria-relevant="additions">
                <ol className="space-y-4">
                  {transcript.map((message) => (
                  <li
                    key={message.id}
                    ref={message.evidence ? evidenceRef : undefined}
                    tabIndex={message.evidence ? -1 : undefined}
                    data-testid={message.evidence ? 'demo-evidence-turn' : message.role === 'interviewer' ? 'demo-message-ai' : undefined}
                    className={`flex ${message.role === 'participant' ? 'justify-end' : 'justify-start'} rounded-xl focus:outline-none ${
                      message.evidence && highlightEvidence ? 'ring-2 ring-amber-300 ring-offset-4 ring-offset-stone-900' : ''
                    }`}
                  >
                    <div
                      className={`max-w-[92%] rounded-2xl p-4 sm:max-w-[78%] ${
                        message.role === 'participant'
                          ? 'rounded-br-md bg-stone-700 text-white'
                          : 'rounded-bl-md border border-stone-700 bg-stone-800 text-stone-100'
                      }`}
                    >
                      <div className={`mb-2 flex items-center gap-2 text-xs font-medium ${message.role === 'participant' ? 'justify-end text-stone-200' : 'text-stone-400'}`}>
                        {message.role === 'interviewer' ? (
                          <>
                            <Bot aria-hidden="true" size={14} />
                            Scripted interviewer
                          </>
                        ) : (
                          <>
                            Maya · fictional participant
                            <User aria-hidden="true" size={14} />
                          </>
                        )}
                      </div>
                      <p className="leading-7">{message.content}</p>
                    </div>
                    </li>
                  ))}
                </ol>
              </div>

              {!interviewComplete && (
                <fieldset
                  ref={choiceGroupRef}
                  tabIndex={-1}
                  className="mt-6 border-t border-stone-700 pt-5 focus:outline-none"
                >
                  <legend className="px-1 text-base font-semibold text-white">Choose Maya’s response</legend>
                  <p className="mb-3 mt-1 text-sm text-stone-400">Every option is fictional and pre-written.</p>
                  <div className="grid gap-3">
                    {choices.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        data-testid={`demo-choice-${choice.id}`}
                        onClick={() => handleChoice(choice)}
                        className="min-h-11 w-full rounded-xl border border-stone-600 bg-stone-800 px-4 py-3 text-left leading-6 text-stone-100 transition-colors hover:border-stone-400 hover:bg-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-850"
                      >
                        {choice.text}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {interviewComplete && (
                <div className="mt-6 border-t border-stone-700 pt-5">
                  <button
                    ref={completionButtonRef}
                    type="button"
                    data-testid="demo-view-insight"
                    onClick={showInsight}
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-stone-100 px-5 py-3 font-semibold text-stone-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 sm:w-auto"
                  >
                    {hasSeenInsight ? 'Return to researcher note' : 'See researcher view'}
                    <ArrowRight aria-hidden="true" size={18} />
                  </button>
                </div>
              )}
            </section>
          </div>
        )}

        {view === 'insight' && branch && (
          <div data-testid="demo-insight" className="space-y-6">
            <header className="space-y-3">
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-stone-400">Researcher view</p>
              <h1 ref={insightHeadingRef} tabIndex={-1} className="text-3xl font-bold text-white outline-none sm:text-4xl">
                Illustrative synthesis
              </h1>
              <p className="max-w-3xl text-lg text-stone-300">
                Based on one fictional interview. This is an interpretation, not a research finding.
              </p>
            </header>

            <div
              data-testid="demo-insight-disclosure"
              className="flex items-start gap-3 rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-100"
            >
              <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
              <p>
                This note was authored in advance for the <strong>{branch.label}</strong> path. No model analyzed Maya or generated these claims.
              </p>
            </div>

            <section aria-labelledby="bottom-line-heading" className="rounded-2xl bg-stone-700 p-5 text-white sm:p-6">
              <div className="mb-3 flex items-center gap-2 text-stone-200">
                <Target aria-hidden="true" size={18} />
                <h2 id="bottom-line-heading" className="text-sm font-semibold uppercase tracking-[0.14em]">Bottom line</h2>
              </div>
              <p className="text-xl font-medium leading-8 sm:text-2xl">{branch.bottomLine}</p>
            </section>

            <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <section aria-labelledby="evidence-heading" className="rounded-2xl border border-stone-700 bg-stone-800/70 p-5 sm:p-6">
                <div className="mb-5 flex items-center gap-2">
                  <Search aria-hidden="true" className="text-stone-400" size={18} />
                  <h2 id="evidence-heading" className="font-semibold text-white">Evidence trail</h2>
                </div>
                <dl className="space-y-5">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">Emerging theme</dt>
                    <dd className="mt-2 font-medium text-stone-100">{branch.theme}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">
                      <Quote aria-hidden="true" size={14} /> Evidence quote
                    </dt>
                    <dd className="mt-2 border-l-2 border-amber-300 pl-4 leading-7 text-stone-200">“{answers[1]}”</dd>
                    <dd className="mt-2 text-xs text-stone-400">Maya · participant response · turn 4</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">Interpretation</dt>
                    <dd className="mt-2 leading-7 text-stone-200">{branch.interpretation}</dd>
                  </div>
                </dl>
              </section>

              <div className="space-y-4">
                <section aria-labelledby="hypothesis-heading" className="rounded-2xl border border-stone-700 bg-stone-800/70 p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <Lightbulb aria-hidden="true" className="text-stone-400" size={18} />
                    <h2 id="hypothesis-heading" className="font-semibold text-white">Hypothesis to test</h2>
                  </div>
                  <p className="text-sm leading-6 text-stone-300">{branch.hypothesis}</p>
                </section>
                <section aria-labelledby="nuance-heading" className="rounded-2xl border border-stone-700 bg-stone-850 p-5">
                  <h2 id="nuance-heading" className="font-semibold text-white">Nuance worth preserving</h2>
                  <p className="mt-2 text-sm leading-6 text-stone-300">{branch.nuance}</p>
                </section>
              </div>
            </div>

            <section aria-labelledby="real-product-heading" className="rounded-2xl border border-stone-700 bg-stone-850 p-5 sm:p-6">
              <h2 id="real-product-heading" className="font-semibold text-white">What changes in a real study?</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-300">
                A configured AI interviewer generates follow-ups from each participant’s words. Researchers then synthesize across interviews while retaining transcripts and evidence provenance. This demo replaces both steps with fixed branches and a pre-written note.
              </p>
            </section>

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                onClick={traceEvidence}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-600 px-5 py-3 font-semibold text-stone-100 hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                <Quote aria-hidden="true" size={18} />
                Trace this insight in the transcript
              </button>
              <button
                type="button"
                onClick={() => resetTo('interview')}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-stone-600 px-5 py-3 font-semibold text-stone-100 hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                <RotateCcw aria-hidden="true" size={18} />
                Replay another path
              </button>
              <Link
                href="/self-host"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-stone-100 px-5 py-3 font-semibold text-stone-900 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                Set up your own instance
                <ArrowRight aria-hidden="true" size={18} />
              </Link>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default DemoSimulation;
