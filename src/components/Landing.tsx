'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Citation, Coordinate, Disclosure, Label, Page, Verbatim } from '@/components/ui';

// Excerpt from the scripted demo's "project" branch (see DemoSimulation.tsx).
// Kept in sync by hand; see the deferred item in D9.
const SPECIMEN = {
  quote:
    'I had forgotten which project it was for, so opening it felt like work before the reading even started.',
  coordinate: 'Scripted demo · Maya · turn 4',
  interpretation:
    'Reconstructing purpose becomes part of the cost of reading, so the saved item feels like unfinished administrative work.',
} as const;

const Landing: React.FC = () => {
  const [specimenOpen, setSpecimenOpen] = useState(true);

  return (
    <main className="min-h-dvh bg-paper-0">
      <Page className="py-12 md:py-20">
        <div className="space-y-16">
          <section aria-labelledby="landing-heading" className="space-y-8">
            <Label>OpenInterviewer · Open source</Label>

            <div>
              <Label>From the scripted demo</Label>
              <Verbatim as="p" className="mt-2 max-w-measure text-[19px] leading-[31px] text-ink-900">
                {SPECIMEN.interpretation}{' '}
                <Citation label="t.4" open={specimenOpen} onOpenChange={setSpecimenOpen}>
                  <span className="block text-[24px] leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]">
                    “{SPECIMEN.quote}”
                  </span>
                  <Coordinate className="mt-3 block">{SPECIMEN.coordinate}</Coordinate>
                </Citation>
              </Verbatim>
            </div>

            <div id="landing-heading">
              <Verbatim as="h1" className="max-w-[24ch] text-[40px] font-normal leading-[44px] text-ink-900 md:text-[56px] md:leading-[58px]">
                Follow the answer, not just the script.
              </Verbatim>
            </div>

            <p className="max-w-measure font-sans text-[17px] leading-[28px] text-ink-700">
              Turn a research guide into an adaptive interview. Participants get thoughtful follow-ups; researchers get interpretations linked back to transcript evidence.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href="/demo"
                className="inline-flex min-h-11 items-center justify-center rounded bg-action px-4 py-2 font-sans text-[15px] font-medium text-paper-1 hover:bg-action/90"
              >
                Try the scripted demo · 2 min
              </Link>
              <Link
                href="/self-host"
                className="inline-flex min-h-11 items-center justify-center rounded border border-ink-300 bg-transparent px-4 py-2 font-sans text-[15px] font-medium text-ink-900 hover:bg-paper-2"
              >
                Self-host your own
              </Link>
            </div>

            <Disclosure title="Safe to try immediately">
              Fictional participant, fixed branches, no account, API key, live AI, interview API call, or saved data.
            </Disclosure>
          </section>

          <section aria-labelledby="workflow-heading" className="space-y-5">
            <div>
              <Label>The research loop</Label>
              <h2 id="workflow-heading" className="mt-2 font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
                From a question to evidence you can inspect.
              </h2>
            </div>
            <ol>
              {[
                {
                  step: '01',
                  title: 'Frame the study',
                  description: 'Define a research question, topic guide, and the context you need from participants.',
                },
                {
                  step: '02',
                  title: 'Follow the thread',
                  description: 'Probe what a participant means instead of mechanically asking the next prepared question.',
                },
                {
                  step: '03',
                  title: 'Trace the insight',
                  description: 'Review interpretations, nuances, and hypotheses alongside their transcript evidence.',
                },
              ].map(({ step, title, description }) => (
                <li key={step} className="grid grid-cols-[3rem_1fr] gap-4 border-t border-ink-300 py-5">
                  <Coordinate>{step}</Coordinate>
                  <div>
                    <h3 className="font-sans text-[15px] font-semibold text-ink-900">{title}</h3>
                    <p className="mt-1 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section
            aria-label="Ways to run OpenInterviewer"
            className="divide-y divide-ink-300 border-t border-ink-300 md:grid md:grid-cols-2 md:gap-10 md:divide-y-0"
          >
            <Link href="/login" className="group block py-6">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900 group-hover:text-action">
                Configured researcher workspace
              </h2>
              <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                Sign in to your workspace. Hosted mode guides you through connecting your own provider and storage; standalone uses the operator&apos;s configuration.
              </p>
              <span className="mt-3 inline-block font-sans text-[13px] font-medium text-action">
                Researcher sign in
              </span>
            </Link>

            <Link href="/self-host" className="group block py-6">
              <h2 className="font-sans text-[15px] font-semibold text-ink-900 group-hover:text-action">
                Self-host
              </h2>
              <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                Deploy the MIT-licensed application with your own provider keys and Upstash database.
              </p>
              <span className="mt-3 inline-block font-sans text-[13px] font-medium text-action">
                View deployment guide
              </span>
            </Link>
          </section>
        </div>
      </Page>
    </main>
  );
};

export default Landing;
