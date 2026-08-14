'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import {
  Download,
  FileJson,
  FileText,
  RotateCcw,
  CheckCircle,
  Copy,
  User,
  Check
} from 'lucide-react';

const Export: React.FC = () => {
  const router = useRouter();
  const {
    studyConfig,
    participantProfile,
    interviewHistory,
    questionProgress,
    behaviorData,
    synthesis,
    viewMode,
    setViewMode,
    setStep,
    resetParticipant,
    reset
  } = useStore();

  const generateJSON = () => {
    // Build profile fields with labels
    const profileFields = participantProfile?.fields.map(f => {
      const schema = studyConfig?.profileSchema.find(s => s.id === f.fieldId);
      return {
        fieldId: f.fieldId,
        label: schema?.label || f.fieldId,
        value: f.value,
        status: f.status,
        extractedAt: f.extractedAt ? new Date(f.extractedAt).toISOString() : null
      };
    }) || [];

    const data = {
      study: {
        id: studyConfig?.id,
        name: studyConfig?.name,
        researchQuestion: studyConfig?.researchQuestion,
        aiBehavior: studyConfig?.aiBehavior,
        coreQuestions: studyConfig?.coreQuestions,
        topicAreas: studyConfig?.topicAreas
      },
      participant: {
        id: participantProfile?.id,
        profile: {
          fields: profileFields,
          rawContext: participantProfile?.rawContext
        }
      },
      interview: {
        messageCount: interviewHistory.length,
        questionsAsked: questionProgress.questionsAsked,
        totalQuestions: studyConfig?.coreQuestions.length || 0,
        duration: interviewHistory.length > 1
          ? (interviewHistory[interviewHistory.length - 1].timestamp - interviewHistory[0].timestamp) / 1000
          : 0,
        transcript: interviewHistory.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp).toISOString()
        }))
      },
      behavior: behaviorData,
      synthesis: synthesis,
      exportedAt: new Date().toISOString()
    };

    return JSON.stringify(data, null, 2);
  };

  const generateTranscript = () => {
    const lines = [
      `# Interview Transcript`,
      `Study: ${studyConfig?.name}`,
      `Research Question: ${studyConfig?.researchQuestion}`,
      `Date: ${new Date().toLocaleDateString()}`,
      ``
    ];

    // Add participant profile summary
    if (participantProfile && participantProfile.fields.length > 0) {
      lines.push(`## Participant Profile`);
      participantProfile.fields.forEach(f => {
        const schema = studyConfig?.profileSchema.find(s => s.id === f.fieldId);
        const label = schema?.label || f.fieldId;
        const value = f.status === 'extracted' ? f.value : `(${f.status})`;
        lines.push(`- **${label}**: ${value}`);
      });
      if (participantProfile.rawContext) {
        lines.push(``);
        lines.push(`**Context**: ${participantProfile.rawContext}`);
      }
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
    lines.push(`## Conversation`);
    lines.push(``);

    interviewHistory.forEach(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = msg.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    });

    if (synthesis) {
      lines.push('---');
      lines.push('');
      lines.push('## Analysis Summary');
      lines.push('');
      lines.push(`**Key Insight:** ${synthesis.bottomLine}`);
      lines.push('');
      if (synthesis.themes.length > 0) {
        lines.push('**Themes:**');
        synthesis.themes.forEach(t => {
          lines.push(`- ${t.theme}: ${t.evidence}`);
        });
        lines.push('');
      }
      if (synthesis.keyInsights.length > 0) {
        lines.push('**Key Insights:**');
        synthesis.keyInsights.forEach(insight => {
          lines.push(`- ${insight}`);
        });
      }
    }

    return lines.join('\n');
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJSON = () => {
    const content = generateJSON();
    const filename = `interview-${studyConfig?.id || 'export'}-${Date.now()}.json`;
    downloadFile(content, filename, 'application/json');
  };

  const handleDownloadTranscript = () => {
    const content = generateTranscript();
    const filename = `transcript-${studyConfig?.id || 'export'}-${Date.now()}.md`;
    downloadFile(content, filename, 'text/markdown');
  };

  const [jsonCopied, setJsonCopied] = useState(false);

  const handleCopyJSON = () => {
    navigator.clipboard.writeText(generateJSON());
    setJsonCopied(true);
    setTimeout(() => setJsonCopied(false), 2000);
  };

  const handleNewParticipant = () => {
    resetParticipant();
    router.push('/consent');
  };

  const handleNewStudy = () => {
    reset();
    router.push('/setup');
  };

  const handleReturnToSynthesis = () => {
    setStep('synthesis');
    router.replace('/synthesis');
  };

  const handleRunPreviewAgain = () => {
    resetParticipant();
    setStep('consent');
    router.push('/consent');
  };

  const handleReturnToStudySetup = () => {
    resetParticipant();
    setViewMode('researcher');
    setStep('setup');
    router.push('/setup');
  };

  // Calculate extracted profile fields
  const extractedFields = participantProfile?.fields.filter(f => f.status === 'extracted') || [];
  const totalFields = participantProfile?.fields.length || 0;

  if (viewMode === 'participant') {
    return (
      <div className="min-h-screen bg-stone-900 p-4 sm:p-8 flex items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-lg rounded-xl border border-stone-700 bg-stone-800/50 p-6 text-center sm:p-8"
        >
          <h1 className="text-2xl font-bold text-white mb-3">Return to interview completion</h1>
          <p className="text-stone-400 mb-6">
            Submission status is shown on the previous screen. This page does not provide researcher export controls.
          </p>
          <button
            type="button"
            onClick={handleReturnToSynthesis}
            className="w-full py-3 bg-stone-600 hover:bg-stone-500 text-white font-semibold rounded-xl transition-colors"
          >
            Return to completion status
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-900 p-4 sm:p-8">
      <div className="max-w-2xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 text-center"
        >
          <div className="w-16 h-16 rounded-full bg-stone-700 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="text-stone-300" size={32} />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">
            {viewMode === 'preview' ? 'Preview complete' : 'Interview Complete'}
          </h1>
          <p className="text-stone-400">
            {viewMode === 'preview'
              ? 'Review or export this local preview. It was not added to study data.'
              : 'Export your data and start a new session'}
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-stone-800/50 rounded-xl border border-stone-700 p-5 space-y-6 sm:p-8"
        >
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <div className="bg-stone-800 rounded-xl p-4">
              <div className="text-2xl font-bold text-white">
                {interviewHistory.length}
              </div>
              <div className="text-xs text-stone-500">Messages</div>
            </div>
            <div className="bg-stone-800 rounded-xl p-4">
              <div className="text-2xl font-bold text-white">
                {questionProgress.questionsAsked.length}/{studyConfig?.coreQuestions.length || 0}
              </div>
              <div className="text-xs text-stone-500">Questions</div>
            </div>
            <div className="bg-stone-800 rounded-xl p-4">
              <div className="text-2xl font-bold text-white">
                {extractedFields.length}/{totalFields}
              </div>
              <div className="text-xs text-stone-500">Profile</div>
            </div>
            <div className="bg-stone-800 rounded-xl p-4">
              <div className="text-2xl font-bold text-white">
                {synthesis?.themes.length || 0}
              </div>
              <div className="text-xs text-stone-500">Themes</div>
            </div>
          </div>

          {/* Participant Profile Summary */}
          {participantProfile && extractedFields.length > 0 && (
            <div className="bg-stone-800 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <User size={16} className="text-stone-400" />
                Participant Profile
              </h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {participantProfile.fields.map(f => {
                  const schema = studyConfig?.profileSchema.find(s => s.id === f.fieldId);
                  return (
                    <div key={f.fieldId} className="flex justify-between items-center py-1">
                      <span className="text-stone-400">{schema?.label || f.fieldId}</span>
                      <span className={`${
                        f.status === 'extracted' ? 'text-stone-200' :
                        f.status === 'refused' ? 'text-stone-500 italic' :
                        'text-stone-500'
                      }`}>
                        {f.status === 'extracted' ? f.value :
                         f.status === 'refused' ? 'Declined' :
                         f.status === 'vague' ? 'Unclear' : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Export Options */}
          <div className="space-y-3">
            <h2 className="font-semibold text-white">Export Data</h2>

            <button
              onClick={handleDownloadJSON}
              className="w-full flex items-center gap-3 p-4 border border-stone-600 rounded-xl hover:bg-stone-700 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-stone-700 flex items-center justify-center">
                <FileJson size={20} className="text-stone-300" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-white">Download JSON</div>
                <div className="text-sm text-stone-400">
                  Full structured data with profile + transcript
                </div>
              </div>
              <Download size={18} className="text-stone-500" />
            </button>

            <button
              onClick={handleDownloadTranscript}
              className="w-full flex items-center gap-3 p-4 border border-stone-600 rounded-xl hover:bg-stone-700 transition-colors text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-stone-700 flex items-center justify-center">
                <FileText size={20} className="text-stone-300" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-white">Download Transcript</div>
                <div className="text-sm text-stone-400">
                  Markdown transcript with profile summary
                </div>
              </div>
              <Download size={18} className="text-stone-500" />
            </button>

            <button
              onClick={handleCopyJSON}
              className={`w-full flex items-center gap-3 p-4 border rounded-xl transition-colors text-left ${
                jsonCopied
                  ? 'border-green-700 bg-green-900/30'
                  : 'border-stone-600 hover:bg-stone-700'
              }`}
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                jsonCopied ? 'bg-green-700' : 'bg-stone-700'
              }`}>
                {jsonCopied ? (
                  <Check size={20} className="text-green-300" />
                ) : (
                  <Copy size={20} className="text-stone-300" />
                )}
              </div>
              <div className="flex-1">
                <div className={`font-medium ${jsonCopied ? 'text-green-300' : 'text-white'}`}>
                  {jsonCopied ? 'Copied!' : 'Copy to Clipboard'}
                </div>
                <div className="text-sm text-stone-400">
                  Copy JSON data to clipboard
                </div>
              </div>
              {jsonCopied ? (
                <Check size={18} className="text-green-400" />
              ) : (
                <Copy size={18} className="text-stone-500" />
              )}
            </button>
          </div>

          {/* Next Actions */}
          <div className="pt-4 border-t border-stone-700 space-y-3">
            <h2 className="font-semibold text-white">What&apos;s Next?</h2>

            {viewMode === 'preview' ? (
              <>
                <button
                  onClick={handleRunPreviewAgain}
                  className="w-full py-3 bg-stone-600 hover:bg-stone-500 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <RotateCcw size={18} />
                  Run preview again
                </button>
                <button
                  onClick={handleReturnToStudySetup}
                  className="w-full py-3 border border-stone-600 text-stone-400 rounded-xl hover:bg-stone-700 transition-colors"
                >
                  Return to study setup
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleNewParticipant}
                  className="w-full py-3 bg-stone-600 hover:bg-stone-500 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <RotateCcw size={18} />
                  New Participant (Same Study)
                </button>
                <button
                  onClick={handleNewStudy}
                  className="w-full py-3 border border-stone-600 text-stone-400 rounded-xl hover:bg-stone-700 transition-colors"
                >
                  Create New Study
                </button>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default Export;
