'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/store';
import { Button, Coordinate, Label, Page, Rule, Verbatim } from '@/components/ui';

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
          const support = t.evidence ?? (t.evidenceRefs ?? []).map(r => `"${r.quote}" (turn ${r.turnIndex})`).join('; ');
          lines.push(support ? `- ${t.theme}: ${support}` : `- ${t.theme}`);
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
      <main className="min-h-dvh bg-paper-0 px-4 py-12 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-measure space-y-6">
          <Verbatim as="h1" className="text-[28px] font-normal leading-[36px] text-ink-900">
            Return to interview completion
          </Verbatim>
          <p className="font-sans text-[15px] leading-[24px] text-ink-700">
            Submission status is shown on the previous screen. This page does not provide researcher export controls.
          </p>
          <Button variant="primary" onClick={handleReturnToSynthesis} className="w-full">
            Return to completion status
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-paper-0">
      <Page className="py-10 md:py-14">
        <div>
          <Label>Session complete</Label>
          <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900">
            {viewMode === 'preview' ? 'Preview complete' : 'Interview Complete'}
          </h1>
          <p className="font-sans text-[15px] leading-[24px] text-ink-700 max-w-measure">
            {viewMode === 'preview'
              ? 'Review or export this local preview. It was not added to study data.'
              : 'Export your data and start a new session'}
          </p>
        </div>

        <Rule className="my-8" />

        {/* Stats */}
        <dl role="group" aria-label="Session summary" className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
          <div className="border-t border-ink-300 py-4">
            <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
              {interviewHistory.length}
            </Coordinate>
            <Label className="mt-1 block">Messages</Label>
          </div>
          <div className="border-t border-ink-300 py-4">
            <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
              {questionProgress.questionsAsked.length}/{studyConfig?.coreQuestions.length || 0}
            </Coordinate>
            <Label className="mt-1 block">Questions</Label>
          </div>
          <div className="border-t border-ink-300 py-4">
            <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
              {extractedFields.length}/{totalFields}
            </Coordinate>
            <Label className="mt-1 block">Profile</Label>
          </div>
          <div className="border-t border-ink-300 py-4">
            <Coordinate className="block text-[28px] leading-[36px] text-ink-900">
              {synthesis?.themes.length || 0}
            </Coordinate>
            <Label className="mt-1 block">Themes</Label>
          </div>
        </dl>

        {/* Participant Profile Summary */}
        {participantProfile && extractedFields.length > 0 && (
          <div className="mt-8">
            <Label>Participant Profile</Label>
            <dl>
              {participantProfile.fields.map(f => {
                const schema = studyConfig?.profileSchema.find(s => s.id === f.fieldId);
                return (
                  <div key={f.fieldId} className="flex items-baseline justify-between gap-4 border-t border-ink-300 py-2">
                    <dt className="font-sans text-[13px] text-ink-500">{schema?.label || f.fieldId}</dt>
                    <dd className={`font-sans text-[13px] ${
                      f.status === 'extracted' ? 'text-ink-900' :
                      f.status === 'refused' ? 'text-ink-500 italic' :
                      'text-ink-500'
                    }`}>
                      {f.status === 'extracted' ? f.value :
                       f.status === 'refused' ? 'Declined' :
                       f.status === 'vague' ? 'Unclear' : '—'}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}

        {/* Export Options */}
        <div className="mt-8">
          <h2 className="font-sans text-[15px] font-semibold text-ink-900">Export Data</h2>

          <button
            type="button"
            onClick={handleDownloadJSON}
            className="group block w-full border-t border-ink-300 py-4 text-left"
          >
            <span className="block font-sans text-[15px] font-medium text-ink-900 group-hover:text-action">Download JSON</span>
            <span className="block font-sans text-[13px] text-ink-500">
              Full structured data with profile + transcript
            </span>
          </button>

          <button
            type="button"
            onClick={handleDownloadTranscript}
            className="group block w-full border-t border-ink-300 py-4 text-left"
          >
            <span className="block font-sans text-[15px] font-medium text-ink-900 group-hover:text-action">Download Transcript</span>
            <span className="block font-sans text-[13px] text-ink-500">
              Markdown transcript with profile summary
            </span>
          </button>

          <button
            type="button"
            onClick={handleCopyJSON}
            className="group block w-full border-t border-ink-300 py-4 text-left"
          >
            <span className={`block font-sans text-[15px] font-medium group-hover:text-action ${jsonCopied ? 'text-success' : 'text-ink-900'}`}>
              {jsonCopied ? 'Copied!' : 'Copy to Clipboard'}
            </span>
            <span className="block font-sans text-[13px] text-ink-500">
              Copy JSON data to clipboard
            </span>
          </button>
        </div>

        {/* Next Actions */}
        <Rule className="my-8" />
        <div className="space-y-3">
          <h2 className="font-sans text-[15px] font-semibold text-ink-900">What&apos;s Next?</h2>

          {viewMode === 'preview' ? (
            <>
              <Button variant="primary" onClick={handleRunPreviewAgain} className="w-full">
                Run preview again
              </Button>
              <Button variant="quiet" onClick={handleReturnToStudySetup} className="w-full">
                Return to study setup
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={handleNewParticipant} className="w-full">
                New Participant (Same Study)
              </Button>
              <Button variant="quiet" onClick={handleNewStudy} className="w-full">
                Create New Study
              </Button>
            </>
          )}
        </div>
      </Page>
    </main>
  );
};

export default Export;
