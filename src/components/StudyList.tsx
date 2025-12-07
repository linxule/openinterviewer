'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { StoredStudy } from '@/types';
import { getAllStudies, deleteStudy } from '@/services/storageService';
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
  LogOut
} from 'lucide-react';

// Preset gradient palettes (50% opacity for punch on dark bg-stone-900)
const gradients = [
  'from-rose-900/50 to-stone-800/50',
  'from-amber-900/50 to-stone-800/50',
  'from-emerald-900/50 to-stone-800/50',
  'from-blue-900/50 to-stone-800/50',
  'from-purple-900/50 to-stone-800/50',
  'from-cyan-900/50 to-stone-800/50',
];

// Hash first topic area to pick a consistent gradient
const getStudyGradient = (topicAreas: string[]) => {
  if (!topicAreas?.length) return gradients[0];
  const hash = topicAreas[0].split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return gradients[hash % gradients.length];
};

const StudyList: React.FC = () => {
  const router = useRouter();
  const [studies, setStudies] = useState<StoredStudy[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    loadStudies();
  }, []);

  const loadStudies = async () => {
    setLoading(true);
    try {
      const data = await getAllStudies();
      setStudies(data);
    } catch (error) {
      console.error('Error loading studies:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this study? This cannot be undone.')) {
      return;
    }

    setDeletingId(id);
    try {
      const result = await deleteStudy(id);
      if (result.success) {
        setStudies(studies.filter(s => s.id !== id));
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

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
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
                <BookOpen className="text-stone-300" size={20} />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white">My Studies</h1>
                <p className="text-stone-400">
                  {studies.length} {studies.length === 1 ? 'study' : 'studies'}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => router.push('/setup')}
                className="px-4 py-2 text-sm bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors flex items-center gap-2"
              >
                <Plus size={16} />
                Create Study
              </button>
              <button
                onClick={() => router.push('/dashboard')}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <Users size={16} />
                All Interviews
              </button>
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
            <h2 className="text-xl font-semibold text-white mb-2">No Studies Yet</h2>
            <p className="text-stone-400 mb-6">
              Create your first study to start collecting interview data.
            </p>
            <button
              onClick={() => router.push('/setup')}
              className="px-6 py-3 bg-stone-600 hover:bg-stone-500 text-white rounded-xl transition-colors flex items-center gap-2 mx-auto"
            >
              <Plus size={18} />
              Create Your First Study
            </button>
          </motion.div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {studies.map((study, index) => (
              <motion.div
                key={study.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className={`bg-gradient-to-br ${getStudyGradient(study.config.topicAreas)} rounded-xl border border-stone-700 p-6 hover:border-stone-500 transition-colors relative`}
              >
                {/* Menu button */}
                <div className="absolute top-4 right-4">
                  <button
                    onClick={() => setMenuOpenId(menuOpenId === study.id ? null : study.id)}
                    className="p-2 text-stone-500 hover:text-stone-400 rounded-lg hover:bg-stone-700"
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
                          // TODO: Navigate to setup with study loaded
                          setMenuOpenId(null);
                        }}
                        disabled={study.isLocked}
                        className="w-full px-4 py-2 text-left text-sm text-stone-300 hover:bg-stone-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <LinkIcon size={14} />
                        Generate Link
                      </button>
                      <button
                        onClick={() => handleDelete(study.id)}
                        disabled={deletingId === study.id || study.interviewCount > 0}
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
                        {study.config.name}
                      </h3>
                      {study.config.description && (
                        <p className="text-sm text-stone-400 line-clamp-2">
                          {study.config.description}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-sm text-stone-500 mb-3">
                    <div className="flex items-center gap-1">
                      <Users size={14} />
                      <span>{study.interviewCount} interviews</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      <span>{formatDate(study.createdAt)}</span>
                    </div>
                  </div>

                  {/* Status badges */}
                  <div className="flex items-center gap-2">
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
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default StudyList;
