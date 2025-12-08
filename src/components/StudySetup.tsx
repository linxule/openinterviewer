'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { useStore } from '@/store';
import { generateParticipantLink } from '@/services/geminiService';
import { StudyConfig, ProfileField, AIBehavior, AIProviderType, LinkExpirationOption, GEMINI_MODELS, CLAUDE_MODELS, DEFAULT_GEMINI_MODEL, DEFAULT_CLAUDE_MODEL } from '@/types';
import {
  FileText,
  Plus,
  X,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Eye,
  Lightbulb,
  User,
  ToggleLeft,
  ToggleRight,
  Link as LinkIcon,
  Copy,
  Check,
  Loader2,
  LogIn,
  Save,
  CheckCircle,
  GitBranch,
  Clock,
  AlertTriangle,
  ExternalLink
} from 'lucide-react';

// Common profile field presets
const PROFILE_PRESETS: ProfileField[] = [
  { id: 'role', label: 'Current Role', extractionHint: 'Their job title or position', required: true },
  { id: 'industry', label: 'Industry', extractionHint: 'The industry they work in', required: false },
  { id: 'experience', label: 'Years of Experience', extractionHint: 'How many years in their field', required: false },
  { id: 'team_size', label: 'Team Size', extractionHint: 'Size of team they work with', required: false },
  { id: 'location', label: 'Location', extractionHint: 'Where they are based (city/region)', required: false }
];

const StudySetup: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setStudyConfig, setStep, studyConfig, loadExampleStudy, setViewMode, setParticipantToken } = useStore();

  // Follow-up study state
  const [parentStudyInfo, setParentStudyInfo] = useState<{ id: string; name: string } | null>(null);

  const [name, setName] = useState(studyConfig?.name || '');
  const [description, setDescription] = useState(studyConfig?.description || '');
  const [researchQuestion, setResearchQuestion] = useState(studyConfig?.researchQuestion || '');
  const [coreQuestions, setCoreQuestions] = useState<string[]>(
    studyConfig?.coreQuestions || ['']
  );
  const [topicAreas, setTopicAreas] = useState<string[]>(
    studyConfig?.topicAreas || ['']
  );
  const [profileSchema, setProfileSchema] = useState<ProfileField[]>(
    studyConfig?.profileSchema || []
  );
  const [aiBehavior, setAiBehavior] = useState<AIBehavior>(
    studyConfig?.aiBehavior || 'standard'
  );
  const [aiProvider, setAiProvider] = useState<AIProviderType>(
    studyConfig?.aiProvider || 'gemini'
  );
  const [aiModel, setAiModel] = useState<string>(
    studyConfig?.aiModel || (studyConfig?.aiProvider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL)
  );
  const [enableReasoning, setEnableReasoning] = useState<boolean | undefined>(
    studyConfig?.enableReasoning
  );
  const [linkExpiration, setLinkExpiration] = useState<LinkExpirationOption>(
    studyConfig?.linkExpiration || 'never'
  );
  const [consentText, setConsentText] = useState(
    studyConfig?.consentText ||
    'Thank you for participating in this research study. Your responses will be used to understand [research topic]. You may stop at any time. Do you consent to participate?'
  );

  // Participant link generation
  const [participantLink, setParticipantLink] = useState<string | null>(null);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  // Preview state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Study save state
  const [savedStudyId, setSavedStudyId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Config status (API keys)
  const [configStatus, setConfigStatus] = useState<{
    hasAnthropicKey: boolean;
    hasGeminiKey: boolean;
  } | null>(null);

  // Sync savedStudyId with persisted config
  // Server-assigned IDs are UUIDs, client-side IDs start with "study-"
  useEffect(() => {
    if (studyConfig?.id && !studyConfig.id.startsWith('study-')) {
      // Server UUID - this is a saved study
      setSavedStudyId(studyConfig.id);
    } else {
      // No config or client-generated ID - clear to prevent overwriting other studies
      setSavedStudyId(null);
    }
  }, [studyConfig?.id]);

  // Check auth status on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth', { method: 'GET' });
        setIsAuthenticated(res.ok);
      } catch {
        setIsAuthenticated(false);
      }
    };
    checkAuth();
  }, []);

  // Fetch config status when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      const fetchConfigStatus = async () => {
        try {
          const res = await fetch('/api/config/status');
          if (res.ok) {
            const data = await res.json();
            setConfigStatus(data);
          }
        } catch {
          // Silently fail - warnings just won't show
        }
      };
      fetchConfigStatus();
    }
  }, [isAuthenticated]);

  // Check for follow-up or edit prefill on mount
  useEffect(() => {
    const prefillType = searchParams.get('prefill');
    if (prefillType === 'followup' || prefillType === 'edit') {
      const prefillData = sessionStorage.getItem('prefillStudyConfig');
      if (prefillData) {
        try {
          const config = JSON.parse(prefillData) as Partial<StudyConfig>;
          // Populate form fields
          if (config.name) setName(config.name);
          if (config.description) setDescription(config.description);
          if (config.researchQuestion) setResearchQuestion(config.researchQuestion);
          if (config.coreQuestions?.length) setCoreQuestions(config.coreQuestions);
          if (config.topicAreas?.length) setTopicAreas(config.topicAreas);
          if (config.profileSchema?.length) setProfileSchema(config.profileSchema);
          if (config.aiBehavior) setAiBehavior(config.aiBehavior);
          if (config.aiProvider) setAiProvider(config.aiProvider);
          if (config.aiModel) setAiModel(config.aiModel);
          if (config.enableReasoning !== undefined) setEnableReasoning(config.enableReasoning);
          if (config.linkExpiration) setLinkExpiration(config.linkExpiration);
          if (config.consentText) setConsentText(config.consentText);

          // Store parent study info for display and saving (followup only)
          if (prefillType === 'followup' && config.parentStudyId && config.parentStudyName) {
            setParentStudyInfo({
              id: config.parentStudyId,
              name: config.parentStudyName
            });
          }

          // For edit mode, set the study ID so saves become updates
          if (prefillType === 'edit') {
            const studyId = searchParams.get('studyId');
            if (studyId) {
              setSavedStudyId(studyId);
              setIsDirty(false); // Not dirty initially - matches saved state
            }
          } else {
            // Mark as dirty since we loaded prefill data that needs saving
            setIsDirty(true);
          }

          // Clear sessionStorage after loading
          sessionStorage.removeItem('prefillStudyConfig');
        } catch (error) {
          console.error('Error parsing prefill config:', error);
        }
      }
    }
  }, [searchParams]);

  // Sync form with studyConfig when it changes (e.g., after loading example)
  useEffect(() => {
    if (studyConfig) {
      setName(studyConfig.name);
      setDescription(studyConfig.description);
      setResearchQuestion(studyConfig.researchQuestion);
      setCoreQuestions(studyConfig.coreQuestions.length > 0 ? studyConfig.coreQuestions : ['']);
      setTopicAreas(studyConfig.topicAreas.length > 0 ? studyConfig.topicAreas : ['']);
      setProfileSchema(studyConfig.profileSchema || []);
      setAiBehavior(studyConfig.aiBehavior);
      setAiProvider(studyConfig.aiProvider || 'gemini');
      setAiModel(studyConfig.aiModel || (studyConfig.aiProvider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL));
      setEnableReasoning(studyConfig.enableReasoning);
      setLinkExpiration(studyConfig.linkExpiration || 'never');
      setConsentText(studyConfig.consentText);
    }
  }, [studyConfig]);

  // Question management
  const addQuestion = () => { setCoreQuestions([...coreQuestions, '']); setIsDirty(true); };
  const removeQuestion = (index: number) => {
    if (coreQuestions.length > 1) {
      setCoreQuestions(coreQuestions.filter((_, i) => i !== index));
      setIsDirty(true);
    }
  };
  const updateQuestion = (index: number, value: string) => {
    const updated = [...coreQuestions];
    updated[index] = value;
    setCoreQuestions(updated);
    setIsDirty(true);
  };

  // Topic management
  const addTopic = () => { setTopicAreas([...topicAreas, '']); setIsDirty(true); };
  const removeTopic = (index: number) => {
    if (topicAreas.length > 1) {
      setTopicAreas(topicAreas.filter((_, i) => i !== index));
      setIsDirty(true);
    }
  };
  const updateTopic = (index: number, value: string) => {
    const updated = [...topicAreas];
    updated[index] = value;
    setTopicAreas(updated);
    setIsDirty(true);
  };

  // Profile field management
  const addProfileField = (preset?: ProfileField) => {
    if (preset) {
      if (!profileSchema.some(f => f.id === preset.id)) {
        setProfileSchema([...profileSchema, preset]);
        setIsDirty(true);
      }
    } else {
      const newField: ProfileField = {
        id: `field-${Date.now()}`,
        label: '',
        extractionHint: '',
        required: false
      };
      setProfileSchema([...profileSchema, newField]);
      setIsDirty(true);
    }
  };

  const removeProfileField = (id: string) => {
    setProfileSchema(profileSchema.filter(f => f.id !== id));
    setIsDirty(true);
  };

  const updateProfileField = (id: string, updates: Partial<ProfileField>) => {
    setProfileSchema(profileSchema.map(f =>
      f.id === id ? { ...f, ...updates } : f
    ));
    setIsDirty(true);
  };

  const toggleFieldRequired = (id: string) => {
    setProfileSchema(profileSchema.map(f =>
      f.id === id ? { ...f, required: !f.required } : f
    ));
    setIsDirty(true);
  };

  const buildConfig = (): StudyConfig => ({
    id: studyConfig?.id || `study-${Date.now()}`,
    name: name || 'Untitled Study',
    description,
    researchQuestion,
    coreQuestions: coreQuestions.filter(q => q.trim()),
    topicAreas: topicAreas.filter(t => t.trim()),
    profileSchema: profileSchema.filter(f => f.label.trim()),
    aiBehavior,
    aiProvider,
    aiModel,
    enableReasoning,
    linkExpiration,
    linksEnabled: true, // Always true when creating/editing (revocation is in StudyDetail)
    consentText,
    createdAt: studyConfig?.createdAt || Date.now(),
    // Include parent study info if this is a follow-up
    ...(parentStudyInfo && {
      parentStudyId: parentStudyInfo.id,
      parentStudyName: parentStudyInfo.name,
      generatedFrom: 'synthesis' as const
    })
  });

  const handleSubmit = () => {
    const config = buildConfig();
    setStudyConfig(config);
    setStep('consent');
    router.push('/consent');
  };

  const handlePreview = async () => {
    setIsPreviewLoading(true);
    const config = buildConfig();
    setStudyConfig(config);

    // Generate a temporary preview token for API authentication
    try {
      const { token } = await generateParticipantLink(config);
      setParticipantToken(token);
    } catch (error) {
      // If token generation fails (e.g., not logged in), proceed anyway
      // The admin session cookie will be used as fallback for authenticated researchers
      console.warn('Could not generate preview token, using session auth:', error);
    }

    setIsPreviewLoading(false);
    setViewMode('participant');
    setStep('consent');
    router.push('/consent');
  };

  const handleGenerateLink = async () => {
    setIsGeneratingLink(true);
    setLinkError(null);
    try {
      const config = buildConfig();
      setStudyConfig(config);

      const response = await fetch('/api/generate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studyConfig: config })
      });

      if (!response.ok) {
        if (response.status === 401) {
          setLinkError('auth');
          setIsAuthenticated(false);
        } else {
          const data = await response.json();
          setLinkError(data.error || 'Failed to generate link');
        }
        return;
      }

      const data = await response.json();
      setParticipantLink(data.url);
    } catch (error) {
      console.error('Error generating link:', error);
      setLinkError('Network error. Please try again.');
    } finally {
      setIsGeneratingLink(false);
    }
  };

  const handleCopyLink = () => {
    if (participantLink) {
      navigator.clipboard.writeText(participantLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const handleSaveStudy = async () => {
    // Fix auth race condition: check for explicit false, not falsy
    if (isAuthenticated === false) {
      router.push('/login');
      return;
    }
    if (isAuthenticated === null) {
      return; // Auth check in progress - button should be disabled anyway
    }

    setIsSaving(true);
    setSaveSuccess(false);

    try {
      const config = buildConfig();
      const isUpdate = !!savedStudyId;

      // For updates, the API may return 409 if study has interviews
      const response = await fetch(
        isUpdate ? `/api/studies/${savedStudyId}` : '/api/studies',
        {
          method: isUpdate ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config })
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          setIsAuthenticated(false);
          router.push('/login');
          return;
        }

        // Handle confirmation required (409) - study has interviews
        if (response.status === 409) {
          const data = await response.json();
          if (data.requiresConfirmation) {
            const confirmed = window.confirm(
              `${data.warning}\n\nDo you want to continue?`
            );
            if (confirmed) {
              // Retry with confirmed: true
              const retryResponse = await fetch(`/api/studies/${savedStudyId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config, confirmed: true })
              });
              if (retryResponse.ok) {
                const retryData = await retryResponse.json();
                setSavedStudyId(retryData.study.id);
                setStudyConfig(retryData.study.config);
                setSaveSuccess(true);
                setIsDirty(false);
                // Navigate to study detail page after confirmed save
                router.push(`/studies/${retryData.study.id}`);
              }
            }
            return;
          }
        }
        return;
      }

      const data = await response.json();
      setSavedStudyId(data.study.id);
      setSaveSuccess(true);
      setStudyConfig(data.study.config);
      setIsDirty(false);

      // Navigate to study detail page after successful save
      router.push(`/studies/${data.study.id}`);
    } catch (error) {
      console.error('Error saving study:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const isValid = name.trim() && researchQuestion.trim();

  const behaviorOptions: { id: AIBehavior; label: string; desc: string }[] = [
    {
      id: 'structured',
      label: 'Focus on covering all questions (Structured)',
      desc: 'Prioritize completion. Minimal follow-ups, redirect tangents.'
    },
    {
      id: 'standard',
      label: 'Balance coverage and depth (Standard)',
      desc: 'Default mode. Follow up on key insights, then move on.'
    },
    {
      id: 'exploratory',
      label: 'Focus on uncovering new insights (Exploratory)',
      desc: 'Prioritize depth. Chase interesting threads, probe emotions.'
    }
  ];

  const providerOptions: { id: AIProviderType; label: string; desc: string }[] = [
    {
      id: 'gemini',
      label: 'Google Gemini',
      desc: 'Fast, cost-effective. Best for high-volume studies.'
    },
    {
      id: 'claude',
      label: 'Anthropic Claude',
      desc: 'Nuanced reasoning. Best for complex, exploratory interviews.'
    }
  ];

  const availablePresets = PROFILE_PRESETS.filter(
    preset => !profileSchema.some(f => f.id === preset.id)
  );

  return (
    <div className="min-h-screen bg-stone-900 p-8">
      <div className="max-w-3xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <button
              onClick={() => router.push('/studies')}
              className="p-2 text-stone-400 hover:text-stone-300 rounded-lg hover:bg-stone-800 transition-colors"
              title="Back to All Studies"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="w-10 h-10 rounded-xl bg-stone-700 flex items-center justify-center">
              <FileText className="text-stone-300" size={20} />
            </div>
            <h1 className="text-3xl font-bold text-white">Study Setup</h1>

            <div className="flex gap-2 ml-auto">
              <button
                onClick={loadExampleStudy}
                className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
              >
                <Lightbulb size={16} />
                Load Example
              </button>
              {isValid && (
                <>
                  <button
                    onClick={handleSaveStudy}
                    disabled={!isAuthenticated || isSaving || (!!savedStudyId && !isDirty)}
                    className={`px-4 py-2 text-sm rounded-xl transition-colors flex items-center gap-2 disabled:cursor-not-allowed ${
                      savedStudyId && !isDirty
                        ? 'bg-green-900/50 text-green-400 border border-green-700'
                        : saveSuccess
                        ? 'bg-green-700 text-white'
                        : 'bg-stone-700 hover:bg-stone-600 text-stone-300'
                    } ${isSaving || isAuthenticated === null ? 'opacity-50' : ''}`}
                  >
                    {isSaving ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : savedStudyId && !isDirty ? (
                      <CheckCircle size={16} />
                    ) : saveSuccess ? (
                      <Check size={16} />
                    ) : (
                      <Save size={16} />
                    )}
                    {isSaving ? 'Saving...' : savedStudyId && isDirty ? 'Update Study' : savedStudyId ? 'Saved' : saveSuccess ? 'Saved!' : 'Save Study'}
                  </button>
                  <button
                    onClick={handlePreview}
                    disabled={isPreviewLoading}
                    className="px-4 py-2 text-sm bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isPreviewLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Eye size={16} />
                    )}
                    {isPreviewLoading ? 'Loading...' : 'Preview'}
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="text-stone-400 ml-[52px]">
            Configure your research interview study
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-stone-800/50 rounded-2xl border border-stone-700 p-8 space-y-8"
        >
          {/* Follow-up Study Banner */}
          {parentStudyInfo && (
            <div className="bg-blue-900/30 border border-blue-700/50 rounded-xl p-4 flex items-start gap-3">
              <GitBranch size={20} className="text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="font-medium text-white">Follow-up Study</h4>
                <p className="text-sm text-stone-400">
                  Based on findings from{' '}
                  <button
                    onClick={() => router.push(`/studies/${parentStudyInfo.id}`)}
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    {parentStudyInfo.name}
                  </button>
                </p>
              </div>
            </div>
          )}

          {/* Basic Info */}
          <div className="space-y-4">
            <h2 className="font-semibold text-lg text-stone-100 flex items-center gap-2">
              <Sparkles size={18} className="text-stone-400" />
              Study Details
            </h2>

            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Study Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setIsDirty(true); }}
                placeholder="e.g., AI Adoption in Healthcare"
                className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Research Question *
              </label>
              <textarea
                value={researchQuestion}
                onChange={(e) => { setResearchQuestion(e.target.value); setIsDirty(true); }}
                placeholder="What are you trying to understand?"
                rows={2}
                className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-300 mb-1">
                Description (optional)
              </label>
              <textarea
                value={description}
                onChange={(e) => { setDescription(e.target.value); setIsDirty(true); }}
                placeholder="Brief context about the study..."
                rows={2}
                className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 resize-none"
              />
            </div>
          </div>

          {/* Profile Fields */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg text-stone-100 flex items-center gap-2">
                <User size={18} className="text-stone-400" />
                Profile Fields
              </h2>
              <button
                onClick={() => addProfileField()}
                className="text-sm text-stone-400 hover:text-stone-300 flex items-center gap-1"
              >
                <Plus size={16} /> Add Custom
              </button>
            </div>
            <p className="text-sm text-stone-400">
              Information to gather about participants during the interview
            </p>

            {availablePresets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-stone-500">Quick add:</span>
                {availablePresets.map(preset => (
                  <button
                    key={preset.id}
                    onClick={() => addProfileField(preset)}
                    className="px-3 py-1 text-xs bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-full transition-colors"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-3">
              {profileSchema.map((field) => (
                <div
                  key={field.id}
                  className="bg-stone-800 rounded-xl p-4 border border-stone-700"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-2">
                      <input
                        type="text"
                        value={field.label}
                        onChange={(e) => updateProfileField(field.id, { label: e.target.value })}
                        placeholder="Field label (e.g., Current Role)"
                        className="w-full px-3 py-2 rounded-lg bg-stone-900 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                      />
                      <input
                        type="text"
                        value={field.extractionHint}
                        onChange={(e) => updateProfileField(field.id, { extractionHint: e.target.value })}
                        placeholder="Hint for AI (e.g., Their job title or position)"
                        className="w-full px-3 py-2 rounded-lg bg-stone-900 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500 text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleFieldRequired(field.id)}
                        className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${
                          field.required
                            ? 'bg-stone-600 text-stone-200'
                            : 'bg-stone-700 text-stone-400'
                        }`}
                        title={field.required ? 'Required field' : 'Optional field'}
                      >
                        {field.required ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                        {field.required ? 'REQ' : 'OPT'}
                      </button>
                      <button
                        onClick={() => removeProfileField(field.id)}
                        className="p-1.5 text-stone-500 hover:text-red-400"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {profileSchema.length === 0 && (
                <div className="text-center py-4 text-stone-500 text-sm">
                  No profile fields yet. Add some above to gather participant information.
                </div>
              )}
            </div>
          </div>

          {/* Core Questions */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg text-stone-100">
                Core Questions
              </h2>
              <button
                onClick={addQuestion}
                className="text-sm text-stone-400 hover:text-stone-300 flex items-center gap-1"
              >
                <Plus size={16} /> Add Question
              </button>
            </div>
            <p className="text-sm text-stone-400">
              Must-ask questions for your interview
            </p>
            <div className="space-y-2">
              {coreQuestions.map((q, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="text-stone-500 text-sm pt-3 w-6 text-right">{i + 1}.</span>
                  <textarea
                    value={q}
                    onChange={(e) => updateQuestion(i, e.target.value)}
                    placeholder={`Question ${i + 1}...`}
                    rows={2}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 resize-none"
                  />
                  {coreQuestions.length > 1 && (
                    <button
                      onClick={() => removeQuestion(i)}
                      className="p-2.5 text-stone-500 hover:text-red-400 mt-1"
                    >
                      <X size={18} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Topic Areas */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-lg text-stone-100">
                Topic Areas
              </h2>
              <button
                onClick={addTopic}
                className="text-sm text-stone-400 hover:text-stone-300 flex items-center gap-1"
              >
                <Plus size={16} /> Add Topic
              </button>
            </div>
            <p className="text-sm text-stone-400">
              Themes the AI should probe on (e.g., fears, motivations, trade-offs)
            </p>
            <div className="space-y-2">
              {topicAreas.map((t, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="text-stone-500 text-sm pt-3 w-6 text-right">{i + 1}.</span>
                  <textarea
                    value={t}
                    onChange={(e) => updateTopic(i, e.target.value)}
                    placeholder={`Topic area ${i + 1}...`}
                    rows={2}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 resize-none"
                  />
                  {topicAreas.length > 1 && (
                    <button
                      onClick={() => removeTopic(i)}
                      className="p-2.5 text-stone-500 hover:text-red-400 mt-1"
                    >
                      <X size={18} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* AI Provider */}
          <div className="space-y-4">
            <h2 className="font-semibold text-lg text-stone-100">AI Provider</h2>
            <p className="text-sm text-stone-400">
              Choose which AI model powers your interviews
            </p>
            <div className="space-y-2">
              {providerOptions.map((option) => (
                <label
                  key={option.id}
                  className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    aiProvider === option.id
                      ? 'border-stone-500 bg-stone-700'
                      : 'border-stone-700 hover:border-stone-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="aiProvider"
                    checked={aiProvider === option.id}
                    onChange={() => {
                      setAiProvider(option.id);
                      // Reset model to provider's default when switching providers
                      setAiModel(option.id === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL);
                      setIsDirty(true);
                    }}
                    className="mt-1 accent-stone-500"
                  />
                  <div>
                    <div className="font-medium text-stone-100">{option.label}</div>
                    <div className="text-xs text-stone-400">{option.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Model Selection */}
            <div className="mt-4 space-y-2">
              <label className="block text-sm font-medium text-stone-300">
                Model
              </label>
              <select
                value={aiModel}
                onChange={(e) => { setAiModel(e.target.value); setIsDirty(true); }}
                className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500"
              >
                {(aiProvider === 'gemini' ? GEMINI_MODELS : CLAUDE_MODELS).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-stone-500">
                {(aiProvider === 'gemini' ? GEMINI_MODELS : CLAUDE_MODELS).find(m => m.id === aiModel)?.desc || ''}
              </p>
            </div>

            {/* AI Reasoning Mode */}
            <div className="mt-4 space-y-2">
              <label className="block text-sm font-medium text-stone-300">
                AI Reasoning Mode
              </label>
              <select
                value={enableReasoning === undefined ? 'auto' : enableReasoning ? 'on' : 'off'}
                onChange={(e) => {
                  const v = e.target.value;
                  setEnableReasoning(v === 'auto' ? undefined : v === 'on');
                  setIsDirty(true);
                }}
                className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500"
              >
                <option value="auto">Automatic (recommended)</option>
                <option value="on">Always enabled</option>
                <option value="off">Always disabled</option>
              </select>
              <p className="text-xs text-stone-500">
                Automatic: OFF for interviews (faster responses), ON for synthesis (deeper analysis using premium models - may increase API costs)
              </p>
            </div>

            {/* Warning: Claude selected but no API key */}
            {aiProvider === 'claude' && configStatus && !configStatus.hasAnthropicKey && (
              <div className="bg-amber-900/30 border border-amber-700/50 rounded-xl p-4 flex items-start gap-3">
                <AlertTriangle size={18} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-medium text-amber-200 text-sm">Anthropic API Key Missing</h4>
                  <p className="text-xs text-stone-400 mt-1">
                    Claude interviews require the <code className="text-stone-300">ANTHROPIC_API_KEY</code> environment variable.
                    Set this in your Vercel dashboard under Project Settings → Environment Variables.
                  </p>
                  <a
                    href="https://github.com/your-repo/research-tool-v2#configuring-api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 mt-2"
                  >
                    View setup guide <ExternalLink size={12} />
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* AI Behavior */}
          <div className="space-y-4">
            <h2 className="font-semibold text-lg text-stone-100">AI Interview Style</h2>
            <div className="space-y-2">
              {behaviorOptions.map((option) => (
                <label
                  key={option.id}
                  className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    aiBehavior === option.id
                      ? 'border-stone-500 bg-stone-700'
                      : 'border-stone-700 hover:border-stone-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="aiBehavior"
                    checked={aiBehavior === option.id}
                    onChange={() => { setAiBehavior(option.id); setIsDirty(true); }}
                    className="mt-1 accent-stone-500"
                  />
                  <div>
                    <div className="font-medium text-stone-100">{option.label}</div>
                    <div className="text-xs text-stone-400">{option.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Link Settings */}
          <div className="space-y-4">
            <h2 className="font-semibold text-lg text-stone-100 flex items-center gap-2">
              <Clock size={18} className="text-stone-400" />
              Link Settings
            </h2>
            <p className="text-sm text-stone-400">
              Configure when participant links expire. You can also revoke links from the study detail page.
            </p>

            <div className="space-y-3">
              <label className="block">
                <span className="text-sm font-medium text-stone-300">Link Expiration</span>
                <select
                  value={linkExpiration}
                  onChange={(e) => { setLinkExpiration(e.target.value as LinkExpirationOption); setIsDirty(true); }}
                  className="mt-1 w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500"
                >
                  <option value="never">Never expire</option>
                  <option value="7days">Expire after 7 days</option>
                  <option value="30days">Expire after 30 days</option>
                  <option value="90days">Expire after 90 days</option>
                </select>
              </label>
              <p className="text-xs text-stone-500">
                Expired links will show an error message when participants try to access them.
              </p>
            </div>
          </div>

          {/* Consent Text */}
          <div className="space-y-4">
            <h2 className="font-semibold text-lg text-stone-100">Consent Text</h2>
            <textarea
              value={consentText}
              onChange={(e) => { setConsentText(e.target.value); setIsDirty(true); }}
              rows={4}
              className="w-full px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-500 focus:border-stone-500 resize-none text-sm"
            />
          </div>

          {/* Generate Participant Link */}
          {isValid && (
            <div className="space-y-4 pt-4 border-t border-stone-700">
              <h2 className="font-semibold text-lg text-stone-100 flex items-center gap-2">
                <LinkIcon size={18} className="text-stone-400" />
                Participant Link
              </h2>

              {participantLink ? (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={participantLink}
                      readOnly
                      className="flex-1 px-4 py-3 rounded-xl bg-stone-800 border border-stone-600 text-stone-300 text-sm font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="px-4 py-3 bg-stone-700 hover:bg-stone-600 text-stone-300 rounded-xl transition-colors flex items-center gap-2"
                    >
                      {linkCopied ? <Check size={18} /> : <Copy size={18} />}
                      {linkCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-xs text-stone-500">
                    Share this link with participants. The study configuration is embedded in the URL.
                  </p>
                </div>
              ) : isAuthenticated === false || linkError === 'auth' ? (
                <div className="space-y-3">
                  <div className="bg-stone-800 border border-stone-600 rounded-xl p-4 text-sm text-stone-300">
                    <p className="mb-3">Login required to generate participant links.</p>
                    <button
                      type="button"
                      onClick={() => router.push('/login')}
                      className="px-4 py-2 bg-stone-600 hover:bg-stone-500 text-white rounded-lg transition-colors flex items-center gap-2"
                    >
                      <LogIn size={16} />
                      Login as Researcher
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={handleGenerateLink}
                    disabled={isGeneratingLink}
                    className="w-full py-3 bg-stone-700 hover:bg-stone-600 text-stone-300 font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <LinkIcon size={18} />
                    {isGeneratingLink ? 'Generating...' : 'Generate Participant Link'}
                  </button>
                  {linkError && linkError !== 'auth' && (
                    <p className="text-sm text-red-400">{linkError}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Submit */}
          <div className="pt-4 border-t border-stone-700">
            <button
              onClick={handleSubmit}
              disabled={!isValid}
              className="w-full py-4 bg-stone-600 hover:bg-stone-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
            >
              Start Interview <ArrowRight size={18} />
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default StudySetup;
