'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { isPendingStudyStub, StudyWorkspaceItem } from '@/types';
import {
  deleteStudy,
  getAllStudies,
  reconcileStudyOperations,
} from '@/services/storageService';
import {
  Loader2,
  Plus,
  BookOpen,
  Users,
  Calendar,
  Lock,
  Unlock,
  Trash2,
  Eye,
  Link as LinkIcon,
  MoreVertical,
  LogOut,
  AlertTriangle,
  Database,
  Sparkles,
  RefreshCw,
  Settings as SettingsIcon
} from 'lucide-react';

const StudyList: React.FC = () => {
  const router = useRouter();
  const [studies, setStudies] = useState<StudyWorkspaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [kvWarning, setKvWarning] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [sampleMessage, setSampleMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hostedMode, setHostedMode] = useState(false);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  const loadStudies = async () => {
    setLoading(true);
    try {
      const { studies: data, pendingStudies, warning, outcome } = await getAllStudies();
      setStudies(data);
      setKvWarning(warning || (outcome.status !== 'ok' ? outcome.error : null));
      if (pendingStudies && pendingStudies.length > 0) {
        setOperationNotice(
          `${pendingStudies.length} study operation(s) are awaiting reconciliation.`,
        );
      }
    } catch (error) {
      console.error('Error loading studies:', error);
    } finally {
      setLoading(false);
    }
  };

  const runReconciliation = async () => {
    setIsReconciling(true);
    const result = await reconcileStudyOperations();
    if (!result.success) {
      setOperationNotice(result.error || 'Study reconciliation is temporarily unavailable.');
    } else if (result.stillPending > 0) {
      setOperationNotice(
        `${result.stillPending} study operation(s) are still inside the safety window. Retry shortly.`
      );
    } else if (result.completed > 0 || result.rolledBack > 0) {
      setOperationNotice('Pending study changes were reconciled successfully.');
    } else {
      setOperationNotice(null);
    }
    setIsReconciling(false);
    await loadStudies();
  };

  useEffect(() => {
    const initializeWorkspace = async () => {
      let hosted = false;
      try {
        const response = await fetch('/api/config/mode');
        const data = await response.json();
        hosted = data.mode === 'hosted';
      } catch {
        hosted = false;
      }
      setHostedMode(hosted);
      if (hosted) {
        await runReconciliation();
      } else {
        await loadStudies();
      }
    };
    void initializeWorkspace();
    // Workspace initialization is intentionally a once-per-mount recovery gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this study? This cannot be undone.')) {
      return;
    }

    setDeletingId(id);
    try {
      const result = await deleteStudy(id);
      if (result.success) {
        setStudies(studies.filter(s => s.id !== id));
      } else if (result.pending) {
        setOperationNotice(result.error || 'Study deletion is awaiting reconciliation.');
      } else {
        alert(result.error || 'Failed to delete study');
      }
    } catch (error) {
      console.error('Error deleting study:', error);
      alert('Failed to delete study');
    } finally {
      setDeletingId(null);
      setMenuOpenId(null);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth', { method: 'DELETE' });
      router.push('/login');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const handleLoadSample = async () => {
    setLoadingSample(true);
    setSampleMessage(null);
    try {
      const response = await fetch('/api/demo/seed', { method: 'POST' });
      const data = await response.json();

      if (response.ok) {
        setSampleMessage({
          type: 'success',
          text: `Sample workspace loaded: ${data.data.studiesSeeded} study, ${data.data.interviewsSeeded} interviews`
        });
        await loadStudies(); // Refresh the list
      } else {
        setSampleMessage({ type: 'error', text: data.error || 'Failed to load sample workspace' });
      }
    } catch (error) {
      console.error('Error loading sample workspace:', error);
      setSampleMessage({ type: 'error', text: 'Failed to load sample workspace' });
    } finally {
      setLoadingSample(false);
    }
  };

  const handleClearSample = async () => {
    if (!confirm('Clear the synthetic sample study and interviews from this workspace?')) return;

    setLoadingSample(true);
    setSampleMessage(null);
    try {
      const response = await fetch('/api/demo/seed', { method: 'DELETE' });
      const data = await response.json();

      if (response.ok) {
        setSampleMessage({ type: 'success', text: 'Sample workspace cleared' });
        await loadStudies(); // Refresh the list
      } else {
        setSampleMessage({ type: 'error', text: data.error || 'Failed to clear sample workspace' });
      }
    } catch (error) {
      console.error('Error clearing sample workspace:', error);
      setSampleMessage({ type: 'error', text: 'Failed to clear sample workspace' });
    } finally {
      setLoadingSample(false);
    }
  };

  // Historical records keep their demo-prefixed IDs for compatibility.
  const hasSampleData = studies.some(s => s.id.startsWith('demo-'));

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div className="min-h-screen bg-stone-900 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center">
                <BookOpen className="text-stone-300" size={20} />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white">My Studies</h1>
                <p className="text-stone-400">
                  {studies.length} {studies.length === 1 ? 'study' : 'studies'}
                </p>
              </div>
            </div>

            <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end sm:gap-3">
              <button
                onClick={() => router.push('/setup')}
                className="px-4 py-2 text-sm bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <Plus size={16} />
                Create Study
              </button>
              <button
                onClick={() => router.push('/dashboard')}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <Users size={16} />
                All Interviews
              </button>
              {hostedMode && (
                <button
                  onClick={() => router.push('/settings')}
                  className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap"
                >
                  <SettingsIcon size={16} />
                  Account &amp; connections
                </button>
              )}
              {hasSampleData ? (
                <button
                  onClick={handleClearSample}
                  disabled={loadingSample}
                  className="px-4 py-2 text-sm border border-amber-700/50 text-amber-400 hover:bg-amber-900/30 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap disabled:opacity-50"
                >
                  {loadingSample ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
                  Clear Sample
                </button>
              ) : (
                <button
                  onClick={handleLoadSample}
                  disabled={loadingSample || !!kvWarning}
                  className="px-4 py-2 text-sm border border-purple-700/50 text-purple-400 hover:bg-purple-900/30 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap disabled:opacity-50"
                >
                  {loadingSample ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  Load Sample
                </button>
              )}
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm border border-stone-600 text-stone-400 hover:bg-stone-700 rounded-xl transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                <LogOut size={16} />
                Logout
              </button>
            </div>
          </div>
        </motion.div>

        {/* Upstash Redis warning banner */}
        {kvWarning && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 flex items-start gap-3"
          >
            <AlertTriangle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h4 className="font-medium text-amber-300 mb-1">
                {kvWarning.toLowerCase().includes('unavailable')
                  ? 'Workspace unavailable'
                  : 'Storage Not Configured'}
              </h4>
              <p className="text-sm text-amber-400/80">{kvWarning}</p>
              {!kvWarning.toLowerCase().includes('unavailable') && (
                <p className="text-sm text-amber-400/60 mt-2">
                  See the README for setup instructions using Upstash Redis.
                </p>
              )}
            </div>
          </motion.div>
        )}

        {operationNotice && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 flex items-center gap-3"
          >
            <AlertTriangle size={20} className="text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-300">{operationNotice}</p>
            {hostedMode && (
              <button
                type="button"
                onClick={() => void runReconciliation()}
                disabled={isReconciling}
                className="ml-auto inline-flex items-center gap-2 rounded-lg border border-amber-700 px-3 py-2 text-sm text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
              >
                <RefreshCw size={14} className={isReconciling ? 'animate-spin' : ''} />
                Reconcile
              </button>
            )}
          </motion.div>
        )}

        {/* Sample workspace message banner */}
        {sampleMessage && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mb-6 rounded-xl p-4 flex items-center gap-3 ${
              sampleMessage.type === 'success'
                ? 'bg-green-900/30 border border-green-700/50'
                : 'bg-red-900/30 border border-red-700/50'
            }`}
          >
            {sampleMessage.type === 'success' ? (
              <Sparkles size={20} className="text-green-400 flex-shrink-0" />
            ) : (
              <AlertTriangle size={20} className="text-red-400 flex-shrink-0" />
            )}
            <p className={`text-sm ${sampleMessage.type === 'success' ? 'text-green-300' : 'text-red-300'}`}>
              {sampleMessage.text}
            </p>
            <button
              onClick={() => setSampleMessage(null)}
              className="ml-auto text-stone-500 hover:text-stone-300"
            >
              ×
            </button>
          </motion.div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={48} className="animate-spin text-stone-400" />
          </div>
        ) : studies.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-stone-800/50 rounded-2xl border border-stone-700 p-12 text-center"
          >
            <div className="w-16 h-16 rounded-full bg-stone-800 flex items-center justify-center mx-auto mb-4">
              <BookOpen size={32} className="text-stone-500" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">
              {kvWarning ? 'Workspace unavailable' : 'No Studies Yet'}
            </h2>
            <p className="text-stone-400 mb-6">
              {kvWarning
                ? kvWarning
                : 'Create your first study or load a synthetic sample workspace.'}
            </p>
            <div className="flex items-center justify-center gap-4">
              {!kvWarning && (
              <button
                onClick={() => router.push('/setup')}
                className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors flex items-center gap-2"
              >
                <Plus size={18} />
                Create Study
              </button>
              )}
              {!kvWarning && (
                <button
                  onClick={handleLoadSample}
                  disabled={loadingSample}
                  className="px-6 py-3 border border-purple-700/50 text-purple-400 hover:bg-purple-900/30 rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {loadingSample ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Sparkles size={18} />
                  )}
                  Load Sample
                </button>
              )}
            </div>
            {!kvWarning && (
              <p className="text-stone-500 text-sm mt-4">
                The sample writes one fictional study, 3 completed interviews, and scripted analysis to your configured storage.
              </p>
            )}
          </motion.div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {studies.map((study, index) => {
              const pending = isPendingStudyStub(study);
              const name = pending ? 'Study change pending' : study.config.name;
              return (
              <motion.div
                key={study.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="bg-stone-800/50 rounded-xl border border-stone-700 p-6 hover:border-stone-500 transition-colors relative"
              >
                {/* Menu button */}
                <div className="absolute top-4 right-4">
                  <button
                    onClick={() => setMenuOpenId(menuOpenId === study.id ? null : study.id)}
                    className="p-2 text-stone-500 hover:text-stone-400 rounded-lg hover:bg-stone-700"
                    aria-label={`Open actions for ${name}`}
                  >
                    <MoreVertical size={16} />
                  </button>
                  {menuOpenId === study.id && (
                    <div className="absolute right-0 mt-1 w-48 bg-stone-800 border border-stone-700 rounded-xl shadow-lg z-10 overflow-hidden">
                      <button
                        onClick={() => {
                          router.push(`/studies/${study.id}`);
                          setMenuOpenId(null);
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-stone-300 hover:bg-stone-700 flex items-center gap-2"
                      >
                        <Eye size={14} />
                        View Details
                      </button>
                      <button
                        onClick={() => {
                          if (pending) return;
                          sessionStorage.setItem('prefillStudyConfig', JSON.stringify(study.config));
                          router.push(`/setup?prefill=edit&studyId=${study.id}`);
                          setMenuOpenId(null);
                        }}
                        disabled={pending}
                        className="w-full px-4 py-2 text-left text-sm text-stone-300 hover:bg-stone-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <LinkIcon size={14} />
                        Edit & Generate Link
                      </button>
                      <button
                        onClick={() => handleDelete(study.id)}
                        disabled={pending || deletingId === study.id || (!pending && study.interviewCount > 0)}
                        className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-stone-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingId === study.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                {/* Content */}
                <div
                  className="cursor-pointer"
                  onClick={() => router.push(`/studies/${study.id}`)}
                >
                  <div className="flex items-start gap-3 mb-3 pr-8">
                    <div className="flex-1">
                      <h3 className="font-semibold text-white text-lg mb-1">
                        {name}
                      </h3>
                      {!pending && study.config.description && (
                        <p className="text-sm text-stone-400 line-clamp-2">
                          {study.config.description}
                        </p>
                      )}
                      {pending && (
                        <p className="text-sm text-amber-300">
                          Reconciliation pending ({study.phase})
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-sm text-stone-500 mb-3">
                    <div className="flex items-center gap-1">
                      <Users size={14} />
                      <span>{pending ? 0 : study.interviewCount} interviews</span>
                    </div>
                    {!pending && (
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      <span>{formatDate(study.createdAt)}</span>
                    </div>
                    )}
                  </div>

                  {/* Status badges */}
                  <div className="flex items-center gap-2">
                    {pending ? (
                      <span className="px-2 py-1 text-xs rounded-full bg-amber-900/50 text-amber-300">
                        Reconciliation pending
                      </span>
                    ) : (
                    <>
                    <span className={`px-2 py-1 text-xs rounded-full flex items-center gap-1 ${
                      study.isLocked
                        ? 'bg-stone-700 text-stone-400'
                        : 'bg-green-900/50 text-green-400'
                    }`}>
                      {study.isLocked ? <Lock size={10} /> : <Unlock size={10} />}
                      {study.isLocked ? 'Locked' : 'Editable'}
                    </span>
                    <span className="px-2 py-1 text-xs rounded-full bg-stone-700 text-stone-400">
                      {study.config.coreQuestions.length} questions
                    </span>
                    </>
                    )}
                  </div>
                </div>
              </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default StudyList;
