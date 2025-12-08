'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { StoredStudy, StoredInterview, AggregateSynthesisResult } from '@/types';
import { getStudy, getStudyInterviews } from '@/services/storageService';
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
  ToggleRight
} from 'lucide-react';

interface StudyDetailProps {
  studyId: string;
}

type TabType = 'overview' | 'interviews' | 'settings';

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

  useEffect(() => {
    loadStudyData();
  }, [studyId]);

  const loadStudyData = async () => {
    setLoading(true);
    try {
      const [studyData, interviewData] = await Promise.all([
        getStudy(studyId),
        getStudyInterviews(studyId)
      ]);
      setStudy(studyData);
      setInterviews(interviewData);
    } catch (error) {
      console.error('Error loading study:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleLinksEnabled = async () => {
    if (!study) return;

    const newLinksEnabled = !(study.config.linksEnabled ?? true);
    setIsTogglingLinks(true);

    try {
      const response = await fetch(`/api/studies/${studyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            ...study.config,
            linksEnabled: newLinksEnabled
          }
        })
      });

      if (!response.ok) {
        throw new Error('Failed to update study');
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

  const handleGenerateAggregateSynthesis = async () => {
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

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate synthesis');
      }

      const data = await response.json();
      setAggregateSynthesis(data.synthesis);
    } catch (error) {
      console.error('Error generating aggregate synthesis:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate synthesis');
    } finally {
      setIsGeneratingAggregate(false);
    }
  };

  const handleGenerateFollowup = async () => {
    if (!aggregateSynthesis) {
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

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate follow-up study');
      }

      const data = await response.json();

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
        <div className="text-center">
          <AlertCircle size={48} className="text-stone-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-white mb-2">Study Not Found</h2>
          <p className="text-stone-400 mb-4">The study you're looking for doesn't exist.</p>
          <button
            onClick={() => router.push('/studies')}
            className="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-white rounded-xl"
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
    { id: 'settings', label: 'Settings', icon: <Settings size={16} /> }
  ];

  return (
    <div className="min-h-screen bg-stone-900 p-8">
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
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-stone-700 flex items-center justify-center">
                <BookOpen className="text-stone-300" size={24} />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white">{study.config.name}</h1>
                <div className="flex items-center gap-3 mt-1 text-sm text-stone-400">
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

        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-stone-700">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 flex items-center gap-2 text-sm font-medium border-b-2 transition-colors ${
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
              <div className="grid grid-cols-3 gap-4">
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
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-white flex items-center gap-2">
                    <BarChart3 size={16} className="text-stone-400" />
                    Aggregate Analysis
                  </h3>
                  <button
                    onClick={handleGenerateAggregateSynthesis}
                    disabled={isGeneratingAggregate || interviews.length < 2}
                    className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
                        disabled={isGeneratingFollowup}
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
                    Click "Analyze All Interviews" to generate cross-interview insights.
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
                    className="bg-stone-800/50 rounded-xl border border-stone-700 p-6 hover:border-stone-600 transition-colors cursor-pointer"
                    onClick={() => router.push(`/dashboard/interview/${interview.id}`)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
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
                        <div className="flex items-center gap-4 text-xs text-stone-500">
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
                        className="p-2 text-stone-400 hover:text-stone-300 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/dashboard/interview/${interview.id}`);
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

                <div className="flex items-center justify-between p-4 bg-stone-900/50 rounded-xl">
                  <div>
                    <div className="font-medium text-stone-200">Participant Links</div>
                    <p className="text-sm text-stone-400">
                      {(study.config.linksEnabled ?? true)
                        ? 'Links are active - participants can access the study'
                        : 'Links are revoked - participants will see an error'}
                    </p>
                  </div>
                  <button
                    onClick={handleToggleLinksEnabled}
                    disabled={isTogglingLinks}
                    className={`w-14 h-7 rounded-full transition-colors flex items-center px-1 ${
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
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
};

export default StudyDetail;
