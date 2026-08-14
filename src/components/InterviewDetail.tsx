'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { StoredInterview } from '@/types';
import { getInterview } from '@/services/storageService';
import ReactMarkdown from 'react-markdown';
import {
  Loader2,
  ArrowLeft,
  Download,
  Clock,
  MessageSquare,
  User,
  Bot,
  Target,
  TrendingUp,
  Lightbulb,
  AlertTriangle
} from 'lucide-react';

interface InterviewDetailProps {
  interviewId: string;
}

const InterviewDetail: React.FC<InterviewDetailProps> = ({ interviewId }) => {
  const router = useRouter();
  const [interview, setInterview] = useState<StoredInterview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transcript' | 'analysis'>('transcript');

  const loadInterview = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getInterview(interviewId);
      setInterview(data);
    } catch (error) {
      console.error('Error loading interview:', error);
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => {
    void loadInterview();
  }, [loadInterview]);

  const handleDownloadJSON = () => {
    if (!interview) return;
    const content = JSON.stringify(interview, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-${interview.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadTranscript = () => {
    if (!interview) return;

    const lines = [
      `# Interview Transcript`,
      `Study: ${interview.studyName}`,
      `Date: ${new Date(interview.createdAt).toLocaleDateString()}`,
      ``
    ];

    // Add participant profile
    if (interview.participantProfile?.fields.length > 0) {
      lines.push(`## Participant Profile`);
      interview.participantProfile.fields.forEach(f => {
        if (f.status === 'extracted' && f.value) {
          lines.push(`- **${f.fieldId}**: ${f.value}`);
        }
      });
      lines.push(``);
    }

    lines.push(`## Conversation`);
    lines.push(``);

    interview.transcript.forEach(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = msg.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    });

    if (interview.synthesis) {
      lines.push(`## Analysis`);
      lines.push(`**Key Insight:** ${interview.synthesis.bottomLine}`);
    }

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${interview.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} minutes`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <Loader2 size={48} className="animate-spin text-stone-400" />
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center p-8">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-white mb-2">Interview Not Found</h1>
          <p className="text-stone-400 mb-4">This interview may have been deleted.</p>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 bg-stone-600 text-white rounded-xl"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-900 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-2 text-stone-400 hover:text-stone-300 mb-4 transition-colors"
          >
            <ArrowLeft size={18} />
            Back to Dashboard
          </button>

          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white mb-2">{interview.studyName}</h1>
              <div className="flex items-center gap-4 text-sm text-stone-400">
                <div className="flex items-center gap-1">
                  <Clock size={14} />
                  {formatDuration(interview.createdAt, interview.completedAt)}
                </div>
                <div className="flex items-center gap-1">
                  <MessageSquare size={14} />
                  {interview.transcript.length} messages
                </div>
                <div>
                  {new Date(interview.createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleDownloadTranscript}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <Download size={16} />
                Transcript
              </button>
              <button
                onClick={handleDownloadJSON}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <Download size={16} />
                JSON
              </button>
            </div>
          </div>
        </motion.div>

        {/* Participant Profile */}
        {interview.participantProfile && interview.participantProfile.fields.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-stone-800/50 rounded-xl border border-stone-700 p-4 mb-6"
          >
            <h3 className="font-semibold text-white flex items-center gap-2 mb-3">
              <User size={16} className="text-stone-400" />
              Participant Profile
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              {interview.participantProfile.fields
                .filter(f => f.status === 'extracted' && f.value)
                .map(f => (
                  <div key={f.fieldId}>
                    <span className="text-stone-500">{f.fieldId}:</span>{' '}
                    <span className="text-stone-200">{f.value}</span>
                  </div>
                ))}
            </div>
          </motion.div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveTab('transcript')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              activeTab === 'transcript'
                ? 'bg-stone-700 text-white'
                : 'text-stone-400 hover:text-stone-300'
            }`}
          >
            Transcript
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={`px-4 py-2 rounded-lg transition-colors ${
              activeTab === 'analysis'
                ? 'bg-stone-700 text-white'
                : 'text-stone-400 hover:text-stone-300'
            }`}
          >
            Analysis
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'transcript' ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-stone-800/50 rounded-xl border border-stone-700 p-6"
          >
            <div className="space-y-4">
              {interview.transcript.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl p-4 ${
                      msg.role === 'user'
                        ? 'bg-stone-700 text-white rounded-br-md'
                        : 'bg-stone-800 border border-stone-700 text-stone-100 rounded-bl-md'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2 text-xs text-stone-500">
                      {msg.role === 'ai' ? (
                        <>
                          <Bot size={14} />
                          Interviewer
                        </>
                      ) : (
                        <>
                          <User size={14} />
                          Participant
                        </>
                      )}
                      <span className="ml-auto">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="prose prose-sm max-w-none prose-invert">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {interview.synthesis ? (
              <>
                {/* Key Insight */}
                <div className="bg-stone-700 text-white rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-2 text-stone-400">
                    <Target size={18} />
                    <span className="text-sm font-medium uppercase tracking-wider">
                      Key Insight
                    </span>
                  </div>
                  <p className="text-xl font-medium">{interview.synthesis.bottomLine}</p>
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
                          {interview.synthesis.statedPreferences.map((item, i) => (
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
                          What behavior revealed
                        </div>
                        <div className="space-y-1">
                          {interview.synthesis.revealedPreferences.map((item, i) => (
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
                      {interview.synthesis.themes.map((theme, i) => (
                        <div key={i} className="border-b border-stone-700 pb-3 last:border-0">
                          <div className="font-medium text-stone-100">{theme.theme}</div>
                          <div className="text-sm text-stone-400 mt-1">{theme.evidence}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Contradictions */}
                {interview.synthesis.contradictions.length > 0 && (
                  <div className="bg-stone-800 border border-stone-600 rounded-xl p-6">
                    <h3 className="font-semibold text-stone-200 mb-3 flex items-center gap-2">
                      <AlertTriangle size={18} className="text-stone-400" />
                      Potential Contradictions
                    </h3>
                    <ul className="space-y-2">
                      {interview.synthesis.contradictions.map((c, i) => (
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
                    {interview.synthesis.keyInsights.map((insight, i) => (
                      <li key={i} className="flex items-start gap-2 text-stone-300">
                        <span className="text-stone-500 mt-1">-</span>
                        {insight}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-12 text-center">
                <p className="text-stone-400">
                  No analysis available for this interview.
                </p>
              </div>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default InterviewDetail;
