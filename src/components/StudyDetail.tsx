'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { StoredStudy, StoredInterview, AggregateSynthesisResult } from '@/types';
import type { ParticipantLinkMetadata } from '@/lib/participantLinks';
import {
  getStudy,
  getStudyInterviews,
  reconcileStudyOperations,
  ResearcherStorageUnavailableError,
  StudyOperationPendingError,
} from '@/services/storageService';
import {
  Loader2,
  ArrowLeft,
  BookOpen,
  Users,
  Settings,
  BarChart3,
  Calendar,
  Lock,
  Unlock,
  Eye,
  Clock,
  MessageSquare,
  Lightbulb,
  Sparkles,
  AlertCircle,
  GitBranch,
  Link as LinkIcon,
  ToggleLeft,
  ToggleRight,
  Copy,
  Check,
  RefreshCw,
  Trash2
} from 'lucide-react';

interface StudyDetailProps {
  studyId: string;
}

type TabType = 'overview' | 'interviews' | 'settings';

function isStudyOperationPending(response: Response, data: { code?: string }) {
  return response.status === 409 && data.code === 'STUDY_OPERATION_PENDING';
}

const StudyDetail: React.FC<StudyDetailProps> = ({ studyId }) => {
  const router = useRouter();
  const [study, setStudy] = useState<StoredStudy | null>(null);
  const [interviews, setInterviews] = useState<StoredInterview[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [aggregateSynthesis, setAggregateSynthesis] = useState<AggregateSynthesisResult | null>(null);
  const [isGeneratingAggregate, setIsGeneratingAggregate] = useState(false);
  const [isGeneratingFollowup, setIsGeneratingFollowup] = useState(false);
  const [isTogglingLinks, setIsTogglingLinks] = useState(false);
  const [participantLink, setParticipantLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [participantLinks, setParticipantLinks] = useState<ParticipantLinkMetadata[]>([]);
  const [linksLoadedAt, setLinksLoadedAt] = useState(0);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  const loadParticipantLinks = useCallback(async () => {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const response = await fetch(`/api/studies/${encodeURIComponent(studyId)}/participant-links`, {
        cache: 'no-store',
      });
      const data = await response.json() as {
        links?: ParticipantLinkMetadata[];
        error?: string;
        code?: string;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        setParticipantLinks([]);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load participant links');
      }
      setParticipantLinks(Array.isArray(data.links) ? data.links : []);
      setLinksLoadedAt(Date.now());
    } catch (error) {
      console.error('Error loading participant links:', error);
      setLinksError(error instanceof Error ? error.message : 'Failed to load participant links');
    } finally {
      setLinksLoading(false);
    }
  }, [studyId]);

  const loadStudyData = useCallback(async () => {
    setLoading(true);
    try {
      const [studyData, interviewData] = await Promise.all([
        getStudy(studyId),
        getStudyInterviews(studyId)
      ]);
      setStudy(studyData);
      setInterviews(interviewData);
      setStorageUnavailable(null);
    } catch (error) {
      if (error instanceof StudyOperationPendingError) {
        setOperationPending(true);
        setInterviews([]);
      } else if (error instanceof ResearcherStorageUnavailableError) {
        setStorageUnavailable(error.message);
        setLinksError(error.message);
      } else {
        console.error('Error loading study:', error);
      }
    } finally {
      setLoading(false);
    }
  }, [studyId]);

  const runReconciliation = async () => {
    setIsReconciling(true);
    const result = await reconcileStudyOperations();
    setIsReconciling(false);
    if (result.success && result.stillPending === 0) {
      setOperationPending(false);
    }
    await loadStudyData();
    await loadParticipantLinks();
  };

  useEffect(() => {
    void loadStudyData();
  }, [loadStudyData]);

  useEffect(() => {
    void loadParticipantLinks();
  }, [loadParticipantLinks]);

  const handleToggleLinksEnabled = async () => {
    if (!study || operationPending) return;

    const newLinksEnabled = !(study.config.linksEnabled ?? true);
    setIsTogglingLinks(true);

    try {
      const response = await fetch(`/api/studies/${studyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linksEnabled: newLinksEnabled })
      });

      const data = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to update study');
      }

      // Update local state
      setStudy({
        ...study,
        config: {
          ...study.config,
          linksEnabled: newLinksEnabled
        }
      });
    } catch (error) {
      console.error('Error toggling links:', error);
      alert('Failed to update link settings');
    } finally {
      setIsTogglingLinks(false);
    }
  };

  const handleGenerateLink = async () => {
    if (!study || operationPending) return;

    setGeneratingLink(true);
    try {
      const response = await fetch('/api/generate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: study.config })
      });

      const data = await response.json().catch(() => ({})) as { error?: string; code?: string; url?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate link');
      }
      if (data.url) {
        setParticipantLink(data.url);
        await loadParticipantLinks();
      }
    } catch (error) {
      console.error('Error generating link:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate link');
    } finally {
      setGeneratingLink(false);
    }
  };

  const handleCopyLink = () => {
    if (participantLink) {
      navigator.clipboard.writeText(participantLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRevokeLink = async (link: ParticipantLinkMetadata) => {
    if (operationPending || link.revokedAt !== null) return;
    if (!window.confirm('Revoke this participant link? Anyone using it will lose access immediately.')) {
      return;
    }

    setRevokingLinkId(link.id);
    try {
      const response = await fetch(`/api/studies/${encodeURIComponent(studyId)}/participant-links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId: link.id }),
      });
      const data = await response.json() as { error?: string; code?: string };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to revoke participant link');
      }
      await loadParticipantLinks();
    } catch (error) {
      console.error('Error revoking participant link:', error);
      alert(error instanceof Error ? error.message : 'Failed to revoke participant link');
    } finally {
      setRevokingLinkId(null);
    }
  };

  const handleGenerateAggregateSynthesis = async () => {
    if (operationPending) return;
    if (interviews.length < 2) {
      alert('Need at least 2 interviews to generate aggregate synthesis');
      return;
    }

    setIsGeneratingAggregate(true);
    try {
      const response = await fetch('/api/synthesis/aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyId })
      });

      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        synthesis?: AggregateSynthesisResult;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate synthesis');
      }
      if (data.synthesis) setAggregateSynthesis(data.synthesis);
    } catch (error) {
      console.error('Error generating aggregate synthesis:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate synthesis');
    } finally {
      setIsGeneratingAggregate(false);
    }
  };

  const handleGenerateFollowup = async () => {
    if (operationPending || !aggregateSynthesis) {
      alert('Generate aggregate analysis first');
      return;
    }

    setIsGeneratingFollowup(true);
    try {
      const response = await fetch(`/api/studies/${studyId}/generate-followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthesis: aggregateSynthesis })
      });

      const data = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        followUpConfig?: unknown;
      };
      if (isStudyOperationPending(response, data)) {
        setOperationPending(true);
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate follow-up study');
      }

      // Store prefill config in sessionStorage and navigate to setup
      sessionStorage.setItem('prefillStudyConfig', JSON.stringify(data.followUpConfig));
      router.push('/setup?prefill=followup');
    } catch (error) {
      console.error('Error generating follow-up study:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate follow-up study');
    } finally {
      setIsGeneratingFollowup(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} min`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <Loader2 size={48} className="animate-spin text-stone-400" />
      </div>
    );
  }

  if (!study) {
    return (
      <div className="min-h-screen bg-stone-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle size={48} className="text-stone-500 mx-auto mb-4" />
          {operationPending ? (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Study change pending</h2>
              <p className="text-stone-400 mb-4">A study operation is already in progress.</p>
              <button
                type="button"
                onClick={() => void runReconciliation()}
                disabled={isReconciling}
                className="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-white rounded-xl disabled:opacity-50"
              >
                {isReconciling ? 'Reconciling…' : 'Reconcile'}
              </button>
            </>
          ) : storageUnavailable ? (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Workspace unavailable</h2>
              <p className="text-stone-400 mb-4">{storageUnavailable}</p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-white mb-2">Study Not Found</h2>
              <p className="text-stone-400 mb-4">The study you&apos;re looking for doesn&apos;t exist.</p>
            </>
          )}
          <button
            onClick={() => router.push('/studies')}
            className="mt-3 px-4 py-2 bg-stone-700 hover:bg-stone-600 text-white rounded-xl"
          >
            Back to Studies
          </button>
        </div>
      </div>
    );
  }

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <BarChart3 size={16} /> },
    { id: 'interviews', label: 'Interviews', icon: <Users size={16} /> },
    { id: 'settings', label: 'Study settings', icon: <Settings size={16} /> }
  ];

  return (
    <div className="min-h-screen bg-stone-900 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <button
            onClick={() => router.push('/studies')}
            className="text-stone-400 hover:text-stone-300 flex items-center gap-2 mb-4"
          >
            <ArrowLeft size={16} />
            Back to Studies
          </button>

          <div className="flex items-start justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-stone-700">
                <BookOpen className="text-stone-300" size={24} />
              </div>
              <div className="min-w-0">
                <h1 className="break-words text-2xl font-bold text-white sm:text-3xl">{study.config.name}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-stone-400 sm:mt-1">
                  <span className="flex items-center gap-1">
                    <Users size={14} />
                    {study.interviewCount} interviews
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar size={14} />
                    Created {formatDate(study.createdAt)}
                  </span>
                  <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                    study.isLocked
                      ? 'bg-stone-700 text-stone-400'
                      : 'bg-green-900/50 text-green-400'
                  }`}>
                    {study.isLocked ? <Lock size={10} /> : <Unlock size={10} />}
                    {study.isLocked ? 'Locked' : 'Editable'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {operationPending && (
          <div className="mb-6 bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 flex items-center gap-3">
            <AlertCircle size={20} className="text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-300">A study operation is already in progress.</p>
            <button
              type="button"
              onClick={() => void runReconciliation()}
              disabled={isReconciling}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-amber-700 px-3 py-2 text-sm text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
            >
              <RefreshCw size={14} className={isReconciling ? 'animate-spin' : ''} />
              Reconcile
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="mb-6 grid grid-cols-3 border-b border-stone-700" role="tablist" aria-label="Study sections">
          {tabs.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex min-w-0 flex-col items-center gap-1 border-b-2 px-2 py-3 text-center text-xs font-medium transition-colors sm:flex-row sm:justify-center sm:gap-2 sm:px-4 sm:text-sm ${
                activeTab === tab.id
                  ? 'border-stone-400 text-white'
                  : 'border-transparent text-stone-500 hover:text-stone-400'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Research Question */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
                <h3 className="font-semibold text-white mb-2 flex items-center gap-2">
                  <Sparkles size={16} className="text-stone-400" />
                  Research Question
                </h3>
                <p className="text-stone-300">{study.config.researchQuestion}</p>
              </div>

              {/* Stats Summary */}
              <div
                role="group"
                aria-label="Study summary"
                className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4"
              >
                <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-4 text-center">
                  <div className="text-3xl font-bold text-white">{study.interviewCount}</div>
                  <div className="text-sm text-stone-400">Interviews</div>
                </div>
                <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-4 text-center">
                  <div className="text-3xl font-bold text-white">{study.config.coreQuestions.length}</div>
                  <div className="text-sm text-stone-400">Core Questions</div>
                </div>
                <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-4 text-center">
                  <div className="text-3xl font-bold text-white">{study.config.topicAreas.length}</div>
                  <div className="text-sm text-stone-400">Topic Areas</div>
                </div>
              </div>

              {/* Aggregate Synthesis */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
                <div className="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="font-semibold text-white flex items-center gap-2">
                    <BarChart3 size={16} className="text-stone-400" />
                    Aggregate Analysis
                  </h3>
                  <button
                    onClick={handleGenerateAggregateSynthesis}
                    disabled={operationPending || isGeneratingAggregate || interviews.length < 2}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-700 px-4 py-2 text-sm text-stone-300 transition-colors hover:bg-stone-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                  >
                    {isGeneratingAggregate ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    {isGeneratingAggregate ? 'Analyzing...' : 'Analyze All Interviews'}
                  </button>
                </div>

                {interviews.length < 2 ? (
                  <p className="text-stone-500 text-sm">
                    Need at least 2 interviews to generate aggregate analysis.
                  </p>
                ) : aggregateSynthesis ? (
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-sm font-medium text-stone-400 mb-2">Key Findings</h4>
                      <ul className="space-y-1">
                        {aggregateSynthesis.keyFindings.map((finding, i) => (
                          <li key={i} className="text-stone-300 text-sm flex items-start gap-2">
                            <span className="text-stone-500">•</span>
                            {finding}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-stone-400 mb-2">Bottom Line</h4>
                      <p className="text-stone-300 text-sm bg-stone-800 rounded-lg p-3">
                        {aggregateSynthesis.bottomLine}
                      </p>
                    </div>

                    {/* Generate Follow-up Study Button */}
                    <div className="pt-4 border-t border-stone-700">
                      <button
                        onClick={handleGenerateFollowup}
                        disabled={operationPending || isGeneratingFollowup}
                        className="px-4 py-2 text-sm bg-stone-600 hover:bg-stone-500 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isGeneratingFollowup ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <GitBranch size={14} />
                        )}
                        {isGeneratingFollowup ? 'Generating...' : 'Create Follow-up Study'}
                      </button>
                      <p className="text-xs text-stone-500 mt-2">
                        Generate a new study based on gaps and patterns found in this analysis.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-stone-500 text-sm">
                    Click &quot;Analyze All Interviews&quot; to generate cross-interview insights.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'interviews' && (
            <div className="space-y-4">
              {interviews.length === 0 ? (
                <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-12 text-center">
                  <Users size={32} className="text-stone-500 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-white mb-2">No Interviews Yet</h3>
                  <p className="text-stone-400 text-sm">
                    Share the participant link to start collecting interviews.
                  </p>
                </div>
              ) : (
                interviews.map((interview, index) => (
                  <motion.div
                    key={interview.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className="cursor-pointer rounded-xl border border-stone-700 bg-stone-800/50 p-4 transition-colors hover:border-stone-600 sm:p-6"
                    onClick={() => router.push(`/dashboard/interview/${interview.id}?studyId=${encodeURIComponent(studyId)}`)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {/* Participant info */}
                        {interview.participantProfile && interview.participantProfile.fields.length > 0 && (
                          <div className="text-sm text-stone-300 mb-3">
                            {interview.participantProfile.fields
                              .filter(f => f.status === 'extracted' && f.value)
                              .slice(0, 3)
                              .map(f => f.value)
                              .join(' • ')}
                          </div>
                        )}

                        {/* Key insight */}
                        {interview.synthesis?.bottomLine && (
                          <div className="flex items-start gap-2 text-sm text-stone-300 bg-stone-800 rounded-lg p-3 mb-3">
                            <Lightbulb size={16} className="text-stone-400 flex-shrink-0 mt-0.5" />
                            <span className="line-clamp-2">{interview.synthesis.bottomLine}</span>
                          </div>
                        )}

                        {/* Stats */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
                          <div className="flex items-center gap-1">
                            <Clock size={12} />
                            {formatDuration(interview.createdAt, interview.completedAt)}
                          </div>
                          <div className="flex items-center gap-1">
                            <MessageSquare size={12} />
                            {interview.transcript.length} messages
                          </div>
                          <div>
                            {formatDate(interview.createdAt)}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        aria-label={`View interview ${index + 1}`}
                        className="p-2 text-stone-400 hover:text-stone-300 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/dashboard/interview/${interview.id}?studyId=${encodeURIComponent(studyId)}`);
                        }}
                      >
                        <Eye size={20} />
                      </button>
                    </div>
                  </motion.div>
                ))
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6">
              {study.interviewCount > 0 && (
                <div className="bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 flex items-start gap-3">
                  <AlertCircle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-white">
                      {study.interviewCount} interview{study.interviewCount > 1 ? 's' : ''} collected
                    </h4>
                    <p className="text-sm text-stone-400">
                      This study has collected data. Editing is allowed but may affect consistency with existing responses.
                    </p>
                  </div>
                </div>
              )}

              {/* Study Config Display */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">Study Name</label>
                  <p className="text-stone-200">{study.config.name}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">Description</label>
                  <p className="text-stone-200">{study.config.description || 'No description'}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">Research Question</label>
                  <p className="text-stone-200">{study.config.researchQuestion}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">
                    Core Questions ({study.config.coreQuestions.length})
                  </label>
                  <ul className="space-y-2">
                    {study.config.coreQuestions.map((q, i) => (
                      <li key={i} className="text-stone-300 text-sm pl-4 border-l-2 border-stone-700">
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">
                    Topic Areas ({study.config.topicAreas.length})
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {study.config.topicAreas.map((topic, i) => (
                      <span key={i} className="px-3 py-1 bg-stone-700 text-stone-300 text-sm rounded-full">
                        {topic}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-400 mb-1">AI Interview Style</label>
                  <p className="text-stone-200 capitalize">{study.config.aiBehavior}</p>
                </div>
              </div>

              {/* Link Management */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6 space-y-4">
                <h3 className="font-semibold text-stone-100 flex items-center gap-2">
                  <LinkIcon size={18} className="text-stone-400" />
                  Link Management
                </h3>

                <div className="flex flex-col items-start gap-3 rounded-xl bg-stone-900/50 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="font-medium text-stone-200">Participant Access</div>
                    <p id="participant-access-status" className="text-sm text-stone-400">
                      {(study.config.linksEnabled ?? true)
                        ? 'Access enabled - participants can use the link below'
                        : 'Access disabled - the same link will show an error until re-enabled'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Participant access"
                    aria-checked={study.config.linksEnabled ?? true}
                    aria-describedby="participant-access-status"
                    onClick={handleToggleLinksEnabled}
                    disabled={operationPending || isTogglingLinks}
                    className={`flex h-7 w-14 shrink-0 items-center rounded-full px-1 transition-colors ${
                      (study.config.linksEnabled ?? true)
                        ? 'bg-green-600'
                        : 'bg-stone-600'
                    } ${isTogglingLinks ? 'opacity-50' : ''}`}
                  >
                    <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                      (study.config.linksEnabled ?? true) ? 'translate-x-7' : 'translate-x-0'
                    }`} />
                  </button>
                </div>

                {study.config.linkExpiration && study.config.linkExpiration !== 'never' && (
                  <div className="flex items-center gap-2 text-sm text-stone-400">
                    <Clock size={14} />
                    <span>Links expire: {study.config.linkExpiration === '7days' ? '7 days' : study.config.linkExpiration === '30days' ? '30 days' : '90 days'} after generation</span>
                  </div>
                )}

                {!(study.config.linksEnabled ?? true) && (
                  <div className="text-xs text-amber-400 bg-amber-900/30 p-3 rounded-lg">
                    Warning: All participant links are currently disabled. Participants trying to access the study will see an error message.
                  </div>
                )}

                <div className="border-t border-stone-700 pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className="font-medium text-stone-200">Generated links</h4>
                      <p className="text-xs text-stone-500">
                        Only dates and status are retained here. Link URLs cannot be viewed again after creation.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadParticipantLinks()}
                      disabled={linksLoading}
                      className="p-2 text-stone-400 hover:text-stone-200 disabled:opacity-50"
                      aria-label="Refresh participant links"
                    >
                      <RefreshCw size={16} className={linksLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  {linksError ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-red-950/30 border border-red-900/50 p-3">
                      <p className="text-sm text-red-300">{linksError}</p>
                      <button
                        type="button"
                        onClick={() => void loadParticipantLinks()}
                        className="text-sm text-red-200 hover:text-white"
                      >
                        Retry
                      </button>
                    </div>
                  ) : linksLoading ? (
                    <div className="flex items-center gap-2 text-sm text-stone-400 py-2">
                      <Loader2 size={16} className="animate-spin" />
                      Loading generated links…
                    </div>
                  ) : participantLinks.length === 0 ? (
                    <p className="text-sm text-stone-500 py-2">No generated links for this study yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {participantLinks.map((link) => {
                        const expired = link.expiresAt !== null && link.expiresAt <= linksLoadedAt;
                        const replaced = link.studyRevision !== study.revision;
                        const status = link.revokedAt !== null
                          ? 'Revoked'
                          : expired
                            ? 'Expired'
                            : replaced
                              ? 'Replaced by study edit'
                              : (study.config.linksEnabled ?? true)
                                ? 'Active'
                                : 'Globally disabled';
                        const canRevoke = link.revokedAt === null && !expired;

                        return (
                          <div
                            key={link.id}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg bg-stone-900/50 p-3"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="text-stone-300">Created {formatDate(link.createdAt)}</span>
                                <span className={`rounded-full px-2 py-0.5 text-xs ${
                                  status === 'Active'
                                    ? 'bg-green-900/50 text-green-300'
                                    : 'bg-stone-700 text-stone-300'
                                }`}>
                                  {status}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-stone-500">
                                {link.expiresAt === null
                                  ? 'No scheduled expiry'
                                  : `Expires ${formatDate(link.expiresAt)}`}
                                {' · '}Study revision {link.studyRevision}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleRevokeLink(link)}
                              disabled={operationPending || !canRevoke || revokingLinkId === link.id}
                              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-900/60 px-3 py-2 text-sm text-red-300 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`Revoke participant link created ${formatDate(link.createdAt)}`}
                            >
                              {revokingLinkId === link.id
                                ? <Loader2 size={14} className="animate-spin" />
                                : <Trash2 size={14} />}
                              Revoke
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Participant Link Generator */}
              <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-6">
                <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                  <LinkIcon size={18} />
                  Participant Link
                </h3>

                <div className="space-y-4">
                  {/* Generate Button */}
                  <button
                    onClick={handleGenerateLink}
                    disabled={operationPending || generatingLink || !(study.config.linksEnabled ?? true)}
                    className="px-4 py-2 bg-stone-600 hover:bg-stone-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                  >
                    {generatingLink ? <Loader2 size={16} className="animate-spin" /> : <LinkIcon size={16} />}
                    Generate New Link
                  </button>

                  {/* Link Display (when generated) */}
                  {participantLink && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={participantLink}
                          readOnly
                          className="flex-1 bg-stone-900 border border-stone-600 rounded-lg px-3 py-2 text-stone-300 text-sm font-mono"
                        />
                        <button
                          onClick={handleCopyLink}
                          className="px-3 py-2 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-lg flex items-center gap-1"
                        >
                          {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                          {copied ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <p className="text-xs text-amber-300">
                        Copy this link now. For security, its URL cannot be recovered from the generated-links list.
                      </p>
                    </div>
                  )}

                  {/* Explanation */}
                  <p className="text-xs text-stone-500">
                    Each click generates a new unique link. All links share the same enable/disable toggle above.
                    {!(study.config.linksEnabled ?? true) && ' Links are currently disabled - enable access above first.'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
};

export default StudyDetail;
