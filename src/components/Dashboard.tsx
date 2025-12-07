'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { StoredInterview, StoredStudy } from '@/types';
import { getAllInterviews, exportAllInterviews, getStudyInterviews, getAllStudies } from '@/services/storageService';
import {
  Loader2,
  FileText,
  Download,
  Eye,
  Clock,
  MessageSquare,
  Lightbulb,
  ArrowLeft,
  FolderOpen,
  LogOut,
  Filter,
  BookOpen
} from 'lucide-react';

const Dashboard: React.FC = () => {
  const router = useRouter();
  const [interviews, setInterviews] = useState<StoredInterview[]>([]);
  const [studies, setStudies] = useState<StoredStudy[]>([]);
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  // Load studies on mount
  useEffect(() => {
    loadStudies();
  }, []);

  // Load interviews when study filter changes
  useEffect(() => {
    loadInterviews(selectedStudyId);
  }, [selectedStudyId]);

  const loadStudies = async () => {
    try {
      const data = await getAllStudies();
      setStudies(data);
    } catch (error) {
      console.error('Error loading studies:', error);
    }
  };

  const loadInterviews = async (studyId: string | null) => {
    setLoading(true);
    try {
      const data = studyId
        ? await getStudyInterviews(studyId)
        : await getAllInterviews();
      setInterviews(data);
    } catch (error) {
      console.error('Error loading interviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExportAll = async () => {
    setExporting(true);
    try {
      const blob = await exportAllInterviews();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `interviews-export-${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Error exporting:', error);
    } finally {
      setExporting(false);
    }
  };

  const handleViewInterview = (id: string) => {
    router.push(`/dashboard/interview/${id}`);
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth', { method: 'DELETE' });
      router.push('/login');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 1000 / 60);
    return `${minutes} min`;
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

  return (
    <div className="min-h-screen bg-stone-900 p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center">
                <FolderOpen className="text-stone-300" size={20} />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white">Interview Dashboard</h1>
                <p className="text-stone-400">
                  {interviews.length} interview{interviews.length !== 1 ? 's' : ''} collected
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => router.push('/studies')}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <BookOpen size={16} />
                My Studies
              </button>
              <button
                onClick={() => router.push('/setup')}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <ArrowLeft size={16} />
                Back to Setup
              </button>
              {interviews.length > 0 && (
                <button
                  onClick={handleExportAll}
                  disabled={exporting}
                  className="px-4 py-2 text-sm bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exporting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}
                  Export All
                </button>
              )}
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm border border-stone-600 text-stone-400 hover:bg-stone-700 rounded-xl transition-colors flex items-center gap-2"
              >
                <LogOut size={16} />
                Logout
              </button>
            </div>
          </div>
        </motion.div>

        {/* Warning */}
        {warning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-6 p-4 bg-stone-800 border border-stone-600 rounded-xl text-stone-300 text-sm"
          >
            {warning}
          </motion.div>
        )}

        {/* Study Filter */}
        {studies.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-6 flex items-center gap-3"
          >
            <Filter size={16} className="text-stone-500" />
            <select
              value={selectedStudyId || ''}
              onChange={(e) => setSelectedStudyId(e.target.value || null)}
              className="px-4 py-2 bg-stone-800 border border-stone-700 rounded-xl text-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-500"
            >
              <option value="">All Studies</option>
              {studies.map((study) => (
                <option key={study.id} value={study.id}>
                  {study.config.name} ({study.interviewCount} interviews)
                </option>
              ))}
            </select>
            {selectedStudyId && (
              <button
                onClick={() => setSelectedStudyId(null)}
                className="text-sm text-stone-500 hover:text-stone-400"
              >
                Clear filter
              </button>
            )}
          </motion.div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={48} className="animate-spin text-stone-400" />
          </div>
        ) : interviews.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-stone-800/50 rounded-2xl border border-stone-700 p-12 text-center"
          >
            <div className="w-16 h-16 rounded-full bg-stone-800 flex items-center justify-center mx-auto mb-4">
              <FileText size={32} className="text-stone-500" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">No Interviews Yet</h2>
            <p className="text-stone-400 mb-6">
              Completed interviews will appear here. Share participant links to start collecting data.
            </p>
            <button
              onClick={() => router.push('/setup')}
              className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors"
            >
              Create Study Link
            </button>
          </motion.div>
        ) : (
          <div className="space-y-4">
            {interviews.map((interview, index) => (
              <motion.div
                key={interview.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="bg-stone-800/50 rounded-xl border border-stone-700 p-6 hover:border-stone-600 transition-colors cursor-pointer"
                onClick={() => handleViewInterview(interview.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-white">{interview.studyName}</h3>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${
                        interview.status === 'completed'
                          ? 'bg-stone-700 text-stone-300'
                          : 'bg-stone-600 text-stone-200'
                      }`}>
                        {interview.status}
                      </span>
                    </div>

                    {/* Participant info */}
                    {interview.participantProfile && interview.participantProfile.fields.length > 0 && (
                      <div className="text-sm text-stone-400 mb-3">
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
                      handleViewInterview(interview.id);
                    }}
                  >
                    <Eye size={20} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
