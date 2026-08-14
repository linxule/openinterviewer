'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Beaker, LogIn, Server } from 'lucide-react';

const Landing: React.FC = () => {
  return (
    <div className="min-h-screen bg-stone-900 flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl w-full space-y-10"
      >
        <div className="space-y-3">
          <p className="text-sm uppercase tracking-wide text-stone-400">OpenInterviewer</p>
          <h1 className="text-4xl font-bold text-white">AI interviews for qualitative research</h1>
          <p className="text-stone-400 text-lg">
            Try a scripted sample first, or sign in to run real studies. The sample never stores data and does not use live AI.
          </p>
        </div>

        <div className="grid gap-4">
          <Link
            href="/demo"
            className="block rounded-2xl border border-stone-700 bg-stone-800/60 p-6 hover:border-stone-500 hover:bg-stone-800 transition-colors"
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center shrink-0">
                <Beaker size={20} className="text-stone-300" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Try a sample</h2>
                <p className="text-sm text-stone-400 mt-1">
                  Keyless, scripted walkthrough. No account, no API keys, no saved responses, and no live model.
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/login"
            className="block rounded-2xl border border-stone-700 bg-stone-800/40 p-6 hover:border-stone-500 hover:bg-stone-800 transition-colors"
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center shrink-0">
                <LogIn size={20} className="text-stone-300" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Researcher workspace</h2>
                <p className="text-sm text-stone-400 mt-1">
                  Sign in to create studies, generate participant links, and review interviews.
                </p>
              </div>
            </div>
          </Link>

          <Link
            href="/self-host"
            className="block rounded-2xl border border-stone-700 bg-stone-800/40 p-6 hover:border-stone-500 hover:bg-stone-800 transition-colors"
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center shrink-0">
                <Server size={20} className="text-stone-300" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Self-host</h2>
                <p className="text-sm text-stone-400 mt-1">
                  Deploy your own instance with your API keys and storage. Open source, MIT licensed.
                </p>
              </div>
            </div>
          </Link>
        </div>
      </motion.div>
    </div>
  );
};

export default Landing;
