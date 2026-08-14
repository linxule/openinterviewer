'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Bot, Send, User } from 'lucide-react';

const GREETING =
  'This is a sample simulation of an AI interview. What would you like to notice about the conversation flow?';
const FOLLOW_UP =
  'In a live study the interviewer would follow that thread. This scripted sample stops here so you can see the shape of the exchange — nothing was stored or sent to a model.';

const DemoSimulation: React.FC = () => {
  const [started, setStarted] = useState(false);
  const [input, setInput] = useState('');
  const [userMessage, setUserMessage] = useState<string | null>(null);
  const [replied, setReplied] = useState(false);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !started || replied) {
      if (replied) setInput('');
      return;
    }
    setUserMessage(text);
    setInput('');
    setReplied(true);
  };

  return (
    <div className="min-h-screen bg-stone-900 flex flex-col">
      <div className="border-b border-amber-700/40 bg-amber-950/40 px-6 py-4">
        <p className="text-amber-100 font-medium">
          This is a sample simulation. It does not use live AI and does not store anything.
        </p>
        <p className="text-amber-200/80 text-sm mt-1">
          Do not enter personal or confidential information.
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <Link href="/login" className="text-amber-100 underline underline-offset-2 hover:text-white">
            Researcher sign in
          </Link>
          <Link href="/login?redirect=/setup" className="text-amber-100 underline underline-offset-2 hover:text-white">
            Set up a real study
          </Link>
        </div>
      </div>

      <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto px-6 py-8">
        {!started ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
            <h1 className="text-3xl font-bold text-white">Try a sample interview</h1>
            <p className="text-stone-400 max-w-md">
              A short, keyless walkthrough of the interview UI. Scripted replies only — no provider, no network, no persistence.
            </p>
            <button
              type="button"
              data-testid="demo-start"
              onClick={() => setStarted(true)}
              className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white font-medium rounded-xl transition-colors"
            >
              Start sample
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 pb-6">
              <div data-testid="demo-message-ai" className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md p-4 bg-stone-800 border border-stone-700 text-stone-100">
                  <div className="flex items-center gap-2 mb-2 text-xs text-stone-500">
                    <Bot size={14} />
                    Sample interviewer
                  </div>
                  <p>{GREETING}</p>
                </div>
              </div>

              {userMessage && (
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md p-4 bg-stone-700 text-white">
                    <div className="flex items-center gap-2 mb-2 text-xs text-stone-400 justify-end">
                      You
                      <User size={14} />
                    </div>
                    <p>{userMessage}</p>
                  </div>
                </div>
              )}

              {replied && (
                <div data-testid="demo-message-ai" className="flex justify-start">
                  <div className="max-w-[80%] rounded-2xl rounded-bl-md p-4 bg-stone-800 border border-stone-700 text-stone-100">
                    <div className="flex items-center gap-2 mb-2 text-xs text-stone-500">
                      <Bot size={14} />
                      Sample interviewer
                    </div>
                    <p>{FOLLOW_UP}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pb-4">
              <label htmlFor="demo-chat-input" className="sr-only">
                Sample response
              </label>
              <input
                id="demo-chat-input"
                type="text"
                data-testid="demo-chat-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Type a sample response..."
                className="flex-1 px-4 py-3 bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 rounded-xl focus:outline-none focus:ring-2 focus:ring-stone-500"
              />
              <button
                type="button"
                aria-label="Send sample response"
                onClick={handleSend}
                disabled={!input.trim()}
                className="p-3 bg-stone-600 hover:bg-stone-500 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={20} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DemoSimulation;
