'use client';

import Link from 'next/link';
import { ArrowRight, Beaker, BookOpen, GitBranch, LogIn, Quote, Server } from 'lucide-react';

const Landing: React.FC = () => {
  return (
    <main className="min-h-dvh bg-stone-900 px-4 py-10 text-stone-100 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl space-y-14">
        <section aria-labelledby="landing-heading" className="grid items-end gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-stone-400">
              OpenInterviewer · Open source
            </p>
            <h1 id="landing-heading" className="max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-6xl sm:leading-[1.05]">
              Follow the answer, not just the script.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-stone-300 sm:text-xl">
              Turn a research guide into an adaptive interview. Participants get thoughtful follow-ups; researchers get interpretations linked back to transcript evidence.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href="/demo"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-stone-100 px-5 py-3 font-semibold text-stone-900 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900"
              >
                Try the scripted demo · 2 min
                <ArrowRight aria-hidden="true" size={18} />
              </Link>
              <Link
                href="/self-host"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-stone-600 px-5 py-3 font-semibold text-stone-100 transition-colors hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                <Server aria-hidden="true" size={18} />
                Self-host your own
              </Link>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-700/40 bg-amber-950/30 p-5">
            <div className="flex items-start gap-3">
              <Beaker aria-hidden="true" className="mt-0.5 shrink-0 text-amber-200" size={20} />
              <div>
                <h2 className="font-semibold text-amber-100">Safe to try immediately</h2>
                <p className="mt-2 text-sm leading-6 text-amber-100/80">
                  Fictional participant, fixed branches, no account, API key, live AI, interview API call, or saved data.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="workflow-heading" className="space-y-5">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-stone-400">The research loop</p>
            <h2 id="workflow-heading" className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
              From a question to evidence you can inspect.
            </h2>
          </div>
          <ol className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: BookOpen,
                step: '01',
                title: 'Frame the study',
                description: 'Define a research question, topic guide, and the context you need from participants.',
              },
              {
                icon: GitBranch,
                step: '02',
                title: 'Follow the thread',
                description: 'Probe what a participant means instead of mechanically asking the next prepared question.',
              },
              {
                icon: Quote,
                step: '03',
                title: 'Trace the insight',
                description: 'Review interpretations, nuances, and hypotheses alongside their transcript evidence.',
              },
            ].map(({ icon: Icon, step, title, description }) => (
              <li key={step} className="rounded-2xl border border-stone-700 bg-stone-800/60 p-5 sm:p-6">
                <div className="flex items-center justify-between">
                  <Icon aria-hidden="true" className="text-stone-300" size={21} />
                  <span className="text-xs font-semibold tracking-[0.16em] text-stone-400">{step}</span>
                </div>
                <h3 className="mt-6 text-lg font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-400">{description}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label="Ways to run OpenInterviewer" className="grid gap-4 border-t border-stone-800 pt-8 sm:grid-cols-2">
          <Link
            href="/login"
            className="group rounded-2xl border border-stone-800 p-5 transition-colors hover:border-stone-600 hover:bg-stone-850"
          >
            <div className="flex items-center gap-3">
              <LogIn aria-hidden="true" className="text-stone-400" size={19} />
              <h2 className="font-semibold text-white">Configured researcher workspace</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-stone-400">
              Sign in to a deployment that already has working storage and provider access.
            </p>
            <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-stone-200 group-hover:text-white">
              Researcher sign in <ArrowRight aria-hidden="true" size={16} />
            </span>
          </Link>

          <Link
            href="/self-host"
            className="group rounded-2xl border border-stone-800 p-5 transition-colors hover:border-stone-600 hover:bg-stone-850"
          >
            <div className="flex items-center gap-3">
              <Server aria-hidden="true" className="text-stone-400" size={19} />
              <h2 className="font-semibold text-white">Self-host</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-stone-400">
              Deploy the MIT-licensed application with your own provider keys and Upstash database.
            </p>
            <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-stone-200 group-hover:text-white">
              View deployment guide <ArrowRight aria-hidden="true" size={16} />
            </span>
          </Link>
        </section>
      </div>
    </main>
  );
};

export default Landing;
