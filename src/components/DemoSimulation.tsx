'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Button, Citation, Coordinate, Disclosure, Label, Page, Rule, Turn, Verbatim } from '@/components/ui';

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
  const [traceOpen, setTraceOpen] = useState(true);
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
    <div className="min-h-dvh bg-paper-0 text-ink-700">
      <aside aria-label="Demo disclosure">
        <Disclosure title="Scripted demo">
          <span className="block">
            Maya is fictional. Every response, follow-up, and insight is pre-written. No demo response leaves this page or survives a refresh.
          </span>
          <nav aria-label="Demo links" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/login" className="underline underline-offset-4">Configured workspace</Link>
            <Link href="/self-host" className="underline underline-offset-4">Self-host setup</Link>
          </nav>
        </Disclosure>
      </aside>

      <main>
        <Page className="py-10 md:py-14">
          {view === 'intro' && (
            <div className="space-y-10">
              <div className="md:grid md:grid-cols-[1.15fr_0.85fr] md:items-start md:gap-10">
                <div className="space-y-5">
                  <Label>Participant view → researcher view</Label>
                  <Verbatim as="h1" className="text-[32px] font-normal leading-[38px] text-ink-900 md:text-[40px] md:leading-[44px]">
                    See an interview become an insight.
                  </Verbatim>
                  <p className="max-w-measure font-sans text-[17px] leading-[28px] text-ink-700">
                    Choose Maya’s fictional replies in a two-minute walkthrough. Watch the interviewer follow her thread, then inspect the evidence behind the researcher note.
                  </p>
                  <Button
                    variant="primary"
                    data-testid="demo-start"
                    className="min-h-11"
                    onClick={() => setView('interview')}
                  >
                    Begin scripted interview
                  </Button>
                </div>

                <section
                  aria-labelledby="demo-study-heading"
                  className="mt-8 border border-ink-300 bg-paper-1 p-5 md:mt-0 md:p-6"
                >
                  <Label>Synthetic study</Label>
                  <h2 id="demo-study-heading" className="mt-2 font-sans text-[18px] font-semibold text-ink-900">
                    {STUDY_NAME}
                  </h2>
                  <Label className="mt-5 block">Research question</Label>
                  <p className="mt-2 font-sans text-[15px] leading-[24px] text-ink-700">{RESEARCH_QUESTION}</p>
                </section>
              </div>

              <ol aria-label="Demo workflow">
                {[
                  ['1', 'Recall a moment', 'Begin with a concrete experience, not an abstract opinion.'],
                  ['2', 'Follow the thread', 'Probe what the participant means instead of reading the next fixed question.'],
                  ['3', 'Trace the insight', 'Keep interpretation beside the exact transcript evidence that supports it.'],
                ].map(([number, title, description]) => (
                  <li key={number} className="grid grid-cols-[3rem_1fr] gap-4 border-t border-ink-300 py-5">
                    <Coordinate>{number}</Coordinate>
                    <div>
                      <h3 className="font-sans text-[15px] font-semibold text-ink-900">{title}</h3>
                      <p className="mt-1 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">{description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {view === 'interview' && (
            <div className="space-y-8">
              <header className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Label>Synthetic study</Label>
                  <button
                    type="button"
                    onClick={() => resetTo('intro')}
                    className="min-h-11 font-sans text-[13px] text-ink-500 underline underline-offset-2 hover:text-ink-900"
                  >
                    Back to overview
                  </button>
                </div>
                <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">{STUDY_NAME}</h1>
                <p className="font-sans text-[15px] leading-[24px] text-ink-700">
                  <span className="font-medium text-ink-900">Research question:</span> {RESEARCH_QUESTION}
                </p>
              </header>

              <div
                role="status"
                data-testid="demo-progress"
                className="flex flex-wrap items-center justify-between gap-3 border-y border-ink-300 py-2"
              >
                <span className="font-sans text-[13px] font-medium text-ink-900">
                  {interviewComplete ? 'Interview complete' : `Question ${answers.length + 1} of 3`}
                </span>
                <Coordinate>{branch ? `Scripted branch: ${branch.label}` : 'Choose the opening path'}</Coordinate>
              </div>

              <section aria-labelledby="transcript-heading" className="relative mt-8">
                <h2 id="transcript-heading" className="sr-only">Scripted interview transcript</h2>
                <div role="log" aria-live="polite" aria-relevant="additions">
                  <ol className="space-y-8">
                    {transcript.map((message, index) => (
                      <li
                        key={message.id}
                        ref={message.evidence ? evidenceRef : undefined}
                        tabIndex={message.evidence ? -1 : undefined}
                        data-testid={message.evidence ? 'demo-evidence-turn' : message.role === 'interviewer' ? 'demo-message-ai' : undefined}
                        className={cn(
                          'focus:outline-none',
                          message.evidence && highlightEvidence && 'ring-2 trace-ring ring-offset-4 ring-offset-paper-0'
                        )}
                      >
                        <Label className={cn('block', message.role === 'participant' && 'md:pl-[3.75rem]')}>
                          {message.role === 'interviewer' ? 'Scripted interviewer' : 'Maya · fictional participant'}
                        </Label>
                        <Turn speaker={message.role} turnIndex={index + 1} showCoordinate className="mt-1">
                          {message.content}
                        </Turn>
                      </li>
                    ))}
                  </ol>
                </div>

                {!interviewComplete && (
                  <fieldset
                    ref={choiceGroupRef}
                    tabIndex={-1}
                    className="mt-8 border-0 border-t border-ink-300 pt-6 focus:outline-none"
                  >
                    <legend className="px-1 font-sans text-[15px] font-semibold text-ink-900">Choose Maya’s response</legend>
                    <p className="mb-4 mt-1 font-sans text-[13px] text-ink-500">Every option is fictional and pre-written.</p>
                    <div className="grid gap-3">
                      {choices.map((choice) => (
                        <Button
                          variant="quiet"
                          key={choice.id}
                          data-testid={`demo-choice-${choice.id}`}
                          onClick={() => handleChoice(choice)}
                          className="min-h-11 w-full text-left leading-[24px]"
                        >
                          {choice.text}
                        </Button>
                      ))}
                    </div>
                  </fieldset>
                )}

                {interviewComplete && (
                  <div className="mt-8 border-t border-ink-300 pt-6">
                    <Button
                      ref={completionButtonRef}
                      variant="primary"
                      data-testid="demo-view-insight"
                      onClick={showInsight}
                      className="min-h-11 w-full sm:w-auto"
                    >
                      {hasSeenInsight ? 'Return to researcher note' : 'See researcher view'}
                    </Button>
                  </div>
                )}
              </section>
            </div>
          )}

          {view === 'insight' && branch && (
            <div data-testid="demo-insight" className="space-y-8">
              <header className="space-y-3">
                <Label>Researcher view</Label>
                <h1
                  ref={insightHeadingRef}
                  tabIndex={-1}
                  className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900 outline-none"
                >
                  Illustrative synthesis
                </h1>
                <p className="font-sans text-[15px] leading-[24px] text-ink-700">
                  Based on one fictional interview. This is an interpretation, not a research finding.
                </p>
              </header>

              <Disclosure data-testid="demo-insight-disclosure">
                This note was authored in advance for the <strong>{branch.label}</strong> path. No model analyzed Maya or generated these claims.
              </Disclosure>

              <section aria-labelledby="bottom-line-heading">
                <h2 id="bottom-line-heading" className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">
                  Bottom line
                </h2>
                <Verbatim as="p" className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">
                  {branch.bottomLine}
                </Verbatim>
                <Rule className="mt-8" />
              </section>

              <section aria-labelledby="evidence-heading">
                <h2 id="evidence-heading" className="font-sans text-[15px] font-semibold text-ink-900">Evidence trail</h2>
                <dl className="mt-5 space-y-5">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">Emerging theme</dt>
                    <dd className="mt-2 font-sans text-[15px] font-medium text-ink-900">{branch.theme}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500">Interpretation</dt>
                    <dd className="mt-2">
                      <Verbatim as="p" className="max-w-measure text-[17px] leading-[28px] text-ink-700">
                        {branch.interpretation}{' '}
                        <Citation label="t.4" open={traceOpen} onOpenChange={setTraceOpen}>
                          <span className="block text-[19px] leading-[31px] text-ink-900">“{answers[1]}”</span>
                          <Coordinate className="mt-2 block">Maya · participant response · turn 4</Coordinate>
                        </Citation>
                      </Verbatim>
                    </dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="hypothesis-heading" className="border-t border-ink-300 pt-5">
                <h2 id="hypothesis-heading" className="font-sans text-[15px] font-semibold text-ink-900">Hypothesis to test</h2>
                <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">{branch.hypothesis}</p>
              </section>

              <section aria-labelledby="nuance-heading" className="border-t border-ink-300 pt-5">
                <h2 id="nuance-heading" className="font-sans text-[15px] font-semibold text-ink-900">Nuance worth preserving</h2>
                <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">{branch.nuance}</p>
              </section>

              <section aria-labelledby="real-product-heading" className="border-t border-ink-300 pt-5">
                <h2 id="real-product-heading" className="font-sans text-[15px] font-semibold text-ink-900">What changes in a real study?</h2>
                <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                  A configured AI interviewer generates follow-ups from each participant’s words. Researchers then synthesize across interviews while retaining transcripts and evidence provenance. This demo replaces both steps with fixed branches and a pre-written note.
                </p>
              </section>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Button variant="quiet" onClick={traceEvidence} className="min-h-11">
                  Trace this insight in the transcript
                </Button>
                <Button variant="quiet" onClick={() => resetTo('interview')} className="min-h-11">
                  Replay another path
                </Button>
                <Link
                  href="/self-host"
                  className="inline-flex min-h-11 items-center justify-center rounded bg-action px-4 py-2 font-sans text-[15px] font-medium text-paper-1 hover:bg-action/90"
                >
                  Set up your own instance
                </Link>
              </div>
            </div>
          )}
        </Page>
      </main>
    </div>
  );
};

export default DemoSimulation;
