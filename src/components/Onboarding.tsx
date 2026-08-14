'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  Database, Key, CheckCircle, ArrowRight, ArrowLeft,
  Loader2, AlertCircle, ExternalLink, Sparkles, ChevronDown, ChevronUp
} from 'lucide-react';

type Step = 'welcome' | 'ai-keys' | 'redis' | 'done';
const STEPS: Step[] = ['welcome', 'ai-keys', 'redis', 'done'];

interface ValidationState {
  loading: boolean;
  valid: boolean | null;
  error: string | null;
}

const Onboarding: React.FC = () => {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [profile, setProfile] = useState<{ name?: string } | null>(null);

  // AI keys state
  const [geminiKey, setGeminiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiValidation, setGeminiValidation] = useState<ValidationState>({ loading: false, valid: null, error: null });
  const [anthropicValidation, setAnthropicValidation] = useState<ValidationState>({ loading: false, valid: null, error: null });

  // Redis state
  const [redisUrl, setRedisUrl] = useState('');
  const [redisToken, setRedisToken] = useState('');
  const [redisValidation, setRedisValidation] = useState<ValidationState>({ loading: false, valid: null, error: null });

  const [saving, setSaving] = useState(false);

  // Expandable guide state
  const [geminiGuideOpen, setGeminiGuideOpen] = useState(false);
  const [claudeGuideOpen, setClaudeGuideOpen] = useState(false);
  const [redisGuideOpen, setRedisGuideOpen] = useState(false);

  // Fetch profile on mount
  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.profile) setProfile(data.profile);
      })
      .catch(() => {});
  }, []);

  const step = STEPS[currentStep];

  const validateAiKey = async (provider: 'gemini' | 'claude', apiKey: string) => {
    const setValidation = provider === 'gemini' ? setGeminiValidation : setAnthropicValidation;
    setValidation({ loading: true, valid: null, error: null });

    try {
      const res = await fetch('/api/onboarding/validate-ai-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await res.json();
      setValidation({ loading: false, valid: data.valid, error: data.error || null });
    } catch {
      setValidation({ loading: false, valid: false, error: 'Validation failed' });
    }
  };

  const validateRedis = async () => {
    setRedisValidation({ loading: true, valid: null, error: null });

    try {
      const res = await fetch('/api/onboarding/validate-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redisUrl, redisToken }),
      });
      const data = await res.json();
      setRedisValidation({ loading: false, valid: data.valid, error: data.error || null });
    } catch {
      setRedisValidation({ loading: false, valid: false, error: 'Validation failed' });
    }
  };

  const [saveError, setSaveError] = useState<string | null>(null);

  const saveAndComplete = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Save credentials
      const saveRes = await fetch('/api/onboarding/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redisUrl: redisUrl || undefined,
          redisToken: redisToken || undefined,
          geminiApiKey: geminiKey || undefined,
          anthropicApiKey: anthropicKey || undefined,
        }),
      });

      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        setSaveError(data.error || 'Failed to save credentials. Please try again.');
        setSaving(false);
        return;
      }

      // Mark onboarding complete
      const completeRes = await fetch('/api/onboarding/complete', { method: 'POST' });
      const completeData = await completeRes.json().catch(() => ({})) as {
        error?: string;
        redirectPath?: string;
      };
      if (!completeRes.ok) {
        setSaveError(completeData.error || 'Failed to complete onboarding. Please try again.');
        setSaving(false);
        return;
      }

      router.push(completeData.redirectPath || '/studies');
    } catch {
      setSaveError('Connection error. Please try again.');
      setSaving(false);
    }
  };

  const canProceedFromAiKeys = geminiValidation.valid || anthropicValidation.valid;
  const canProceedFromRedis = redisValidation.valid;

  const ValidationBadge: React.FC<{ state: ValidationState }> = ({ state }) => {
    if (state.loading) return <Loader2 size={16} className="animate-spin text-stone-400" />;
    if (state.valid === true) return <CheckCircle size={16} className="text-green-400" />;
    if (state.valid === false) return <AlertCircle size={16} className="text-red-400" />;
    return null;
  };

  return (
    <div className="min-h-screen bg-stone-900 flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-lg w-full"
      >
        {/* Progress bar */}
        <div className="flex gap-2 mb-8">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= currentStep ? 'bg-stone-400' : 'bg-stone-700'
              }`}
            />
          ))}
        </div>

        <div className="bg-stone-800/50 rounded-xl border border-stone-700 p-8">
          <AnimatePresence mode="wait">
            {step === 'welcome' && (
              <motion.div key="welcome" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <div className="text-center mb-6">
                  <div className="w-14 h-14 rounded-full bg-stone-700 flex items-center justify-center mx-auto mb-4">
                    <Sparkles size={28} className="text-stone-300" />
                  </div>
                  <h1 className="text-2xl font-bold text-white">
                    Welcome{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}!
                  </h1>
                  <p className="text-stone-400 mt-3 leading-relaxed">
                    Let&apos;s get you set up. OpenInterviewer uses a <strong className="text-stone-300">Bring Your Own Storage</strong> model &mdash;
                    your data stays in your own infrastructure, giving you full control over your research data.
                  </p>
                </div>

                <div className="space-y-3 mb-6">
                  <div className="flex items-start gap-3 p-3 bg-stone-800 rounded-lg">
                    <Key size={18} className="text-stone-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-stone-200 text-sm font-medium">AI API Key</p>
                      <p className="text-stone-400 text-xs">Gemini or Claude key for AI-powered interviews</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 p-3 bg-stone-800 rounded-lg">
                    <Database size={18} className="text-stone-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-stone-200 text-sm font-medium">Upstash Redis</p>
                      <p className="text-stone-400 text-xs">Free-tier database to store your studies and interviews</p>
                    </div>
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-blue-400/20 bg-blue-500/5 text-xs text-stone-400 leading-relaxed">
                  The hosted server receives these credentials over its encrypted connection, stores them
                  encrypted, and decrypts them in memory when it connects on your behalf. The app operator
                  controls the encryption keys and can technically decrypt the stored values. The service can
                  read and write the supplied Redis database, and participant interview content is sent to the
                  AI provider you select. You can clear the connection here later; rotate the keys or tokens at
                  their providers to revoke access completely.
                </div>
              </motion.div>
            )}

            {step === 'ai-keys' && (
              <motion.div key="ai-keys" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <h2 className="text-xl font-bold text-white mb-1">AI API Key</h2>
                <p className="text-stone-400 text-sm mb-6">
                  Add at least one AI provider key. You can add both for flexibility.
                </p>

                <div className="space-y-5">
                  {/* Gemini */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="onboarding-gemini-key" className="text-sm font-medium text-stone-300">Google Gemini API Key</label>
                      <ValidationBadge state={geminiValidation} />
                    </div>
                    <div className="flex gap-2">
                      <input
                        id="onboarding-gemini-key"
                        type="password"
                        value={geminiKey}
                        onChange={(e) => { setGeminiKey(e.target.value); setGeminiValidation({ loading: false, valid: null, error: null }); }}
                        placeholder="AIza..."
                        className="flex-1 px-3 py-2 rounded-lg bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 text-sm focus:outline-none focus:ring-2 focus:ring-stone-500"
                      />
                      <button
                        onClick={() => validateAiKey('gemini', geminiKey)}
                        disabled={!geminiKey || geminiValidation.loading}
                        className="px-3 py-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 text-stone-300 text-sm rounded-lg transition-colors"
                      >
                        Test
                      </button>
                    </div>
                    {geminiValidation.error && <p className="text-red-400 text-xs mt-1">{geminiValidation.error}</p>}

                    {/* Expandable setup guide */}
                    <div className="mt-2">
                      <button
                        onClick={() => setGeminiGuideOpen(!geminiGuideOpen)}
                        className="text-xs text-stone-500 hover:text-stone-400 inline-flex items-center gap-1"
                      >
                        {geminiGuideOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        How to get a Gemini API key
                      </button>

                      {geminiGuideOpen && (
                        <div className="mt-2 p-3 bg-stone-800/30 border border-stone-600 rounded-lg text-xs space-y-2">
                          <ol className="list-decimal list-inside space-y-1 text-stone-300">
                            <li>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-300 underline">aistudio.google.com/apikey</a></li>
                            <li>Sign in with any Google account</li>
                            <li>Click &quot;Create API key&quot; (auto-creates a Google Cloud project)</li>
                            <li>Copy the key (starts with AIza)</li>
                          </ol>
                          <div className="flex items-start gap-1.5 text-stone-400 mt-2">
                            <span>•</span>
                            <span>No credit card required</span>
                          </div>
                          <div className="flex items-start gap-1.5 text-stone-400">
                            <span>•</span>
                            <span>Free tier: 10 req/min, 250 req/day for Gemini 2.5 Flash</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Claude */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="onboarding-claude-key" className="text-sm font-medium text-stone-300">Anthropic Claude API Key</label>
                      <ValidationBadge state={anthropicValidation} />
                    </div>
                    <div className="flex gap-2">
                      <input
                        id="onboarding-claude-key"
                        type="password"
                        value={anthropicKey}
                        onChange={(e) => { setAnthropicKey(e.target.value); setAnthropicValidation({ loading: false, valid: null, error: null }); }}
                        placeholder="sk-ant-..."
                        className="flex-1 px-3 py-2 rounded-lg bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 text-sm focus:outline-none focus:ring-2 focus:ring-stone-500"
                      />
                      <button
                        onClick={() => validateAiKey('claude', anthropicKey)}
                        disabled={!anthropicKey || anthropicValidation.loading}
                        className="px-3 py-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 text-stone-300 text-sm rounded-lg transition-colors"
                      >
                        Test
                      </button>
                    </div>
                    {anthropicValidation.error && <p className="text-red-400 text-xs mt-1">{anthropicValidation.error}</p>}

                    {/* Expandable setup guide */}
                    <div className="mt-2">
                      <button
                        onClick={() => setClaudeGuideOpen(!claudeGuideOpen)}
                        className="text-xs text-stone-500 hover:text-stone-400 inline-flex items-center gap-1"
                      >
                        {claudeGuideOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        How to get a Claude API key
                      </button>

                      {claudeGuideOpen && (
                        <div className="mt-2 p-3 bg-stone-800/30 border border-stone-600 rounded-lg text-xs space-y-2">
                          <ol className="list-decimal list-inside space-y-1 text-stone-300">
                            <li>Go to <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-300 underline">console.anthropic.com</a></li>
                            <li>Sign up with email or Google account</li>
                            <li>Claim $5 free credits (requires phone verification, US numbers only)</li>
                            <li>Go to API Keys → Create API Key → copy it (starts with sk-ant-)</li>
                          </ol>
                          <div className="flex items-start gap-1.5 text-stone-400 mt-2">
                            <span>•</span>
                            <span>$5 free credits ≈ 15-100 interviews with Haiku</span>
                          </div>
                          <div className="flex items-start gap-1.5 text-amber-400">
                            <span>•</span>
                            <span>Credit card required after free credits expire</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 'redis' && (
              <motion.div key="redis" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <h2 className="text-xl font-bold text-white mb-1">Upstash Redis</h2>
                <p className="text-stone-400 text-sm mb-6">
                  Your studies and interview data will be stored in your own Upstash Redis database.
                  The free tier is more than enough to get started.
                </p>

                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="onboarding-redis-url" className="text-sm font-medium text-stone-300">REST API URL</label>
                    </div>
                    <input
                      id="onboarding-redis-url"
                      type="text"
                      value={redisUrl}
                      onChange={(e) => { setRedisUrl(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
                      placeholder="https://your-db.upstash.io"
                      className="w-full px-3 py-2 rounded-lg bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 text-sm focus:outline-none focus:ring-2 focus:ring-stone-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="onboarding-redis-token" className="text-sm font-medium text-stone-300 mb-1 block">REST API Token</label>
                    <input
                      id="onboarding-redis-token"
                      type="password"
                      value={redisToken}
                      onChange={(e) => { setRedisToken(e.target.value); setRedisValidation({ loading: false, valid: null, error: null }); }}
                      placeholder="AXxx..."
                      className="w-full px-3 py-2 rounded-lg bg-stone-800 border border-stone-600 text-stone-100 placeholder-stone-500 text-sm focus:outline-none focus:ring-2 focus:ring-stone-500"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ValidationBadge state={redisValidation} />
                      {redisValidation.valid && <span className="text-green-400 text-sm">Connected</span>}
                      {redisValidation.error && <span className="text-red-400 text-sm">{redisValidation.error}</span>}
                    </div>
                    <button
                      onClick={validateRedis}
                      disabled={!redisUrl || !redisToken || redisValidation.loading}
                      className="px-4 py-2 bg-stone-700 hover:bg-stone-600 disabled:opacity-50 text-stone-300 text-sm rounded-lg transition-colors"
                    >
                      {redisValidation.loading ? 'Testing...' : 'Test Connection'}
                    </button>
                  </div>

                  {/* Expandable setup guide */}
                  <div>
                    <button
                      onClick={() => setRedisGuideOpen(!redisGuideOpen)}
                      className="text-xs text-stone-500 hover:text-stone-400 inline-flex items-center gap-1"
                    >
                      {redisGuideOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      How to set up Upstash Redis
                    </button>

                    {redisGuideOpen && (
                      <div className="mt-2 p-3 bg-stone-800/30 border border-stone-600 rounded-lg text-xs space-y-2">
                        <ol className="list-decimal list-inside space-y-1 text-stone-300">
                          <li>Go to <a href="https://console.upstash.com" target="_blank" rel="noopener noreferrer" className="text-stone-400 hover:text-stone-300 underline">console.upstash.com</a> and sign up with Google/GitHub</li>
                          <li>Click &quot;+ Create Database&quot;</li>
                          <li>Choose Regional (recommended), select nearest region</li>
                          <li>Select Free plan (256 MB, 500K commands/month)</li>
                          <li>After creation, go to database details → REST API section</li>
                          <li>Copy REST URL (https://*.upstash.io) and REST Token</li>
                        </ol>
                        <div className="flex items-start gap-1.5 text-amber-400 mt-2">
                          <span>⚠</span>
                          <span>Use the REST URL (https://), not the regular Redis URL (redis://)</span>
                        </div>
                        <div className="flex items-start gap-1.5 text-stone-400">
                          <span>•</span>
                          <span>Free tier: 1 database, 256 MB, 500K commands/month</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {step === 'done' && (
              <motion.div key="done" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <div className="text-center">
                  <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle size={28} className="text-green-400" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">You&apos;re all set!</h2>
                  <p className="text-stone-400 text-sm mb-6">
                    Your credentials have been encrypted and stored by the hosted platform.
                    You&apos;re ready to create your first study.
                  </p>

                  <div className="space-y-2 mb-6 text-left">
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle size={14} className="text-green-400" />
                      <span className="text-stone-300">
                        AI: {geminiValidation.valid && anthropicValidation.valid ? 'Gemini + Claude' : geminiValidation.valid ? 'Gemini' : 'Claude'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <CheckCircle size={14} className="text-green-400" />
                      <span className="text-stone-300">Storage: Upstash Redis connected</span>
                    </div>
                  </div>

                  {saveError && (
                    <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                      <AlertCircle size={16} className="flex-shrink-0" />
                      {saveError}
                    </div>
                  )}

                  <button
                    onClick={saveAndComplete}
                    disabled={saving}
                    className="w-full py-3 bg-stone-600 hover:bg-stone-500 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {saving ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        Create Your First Study
                        <ArrowRight size={18} />
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation */}
          {step !== 'done' && (
            <div className="flex justify-between mt-8 pt-6 border-t border-stone-700">
              <button
                onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
                disabled={currentStep === 0}
                className="flex items-center gap-1 text-sm text-stone-400 hover:text-stone-300 disabled:opacity-30 transition-colors"
              >
                <ArrowLeft size={14} />
                Back
              </button>
              <button
                onClick={() => setCurrentStep(currentStep + 1)}
                disabled={
                  (step === 'ai-keys' && !canProceedFromAiKeys) ||
                  (step === 'redis' && !canProceedFromRedis)
                }
                className="flex items-center gap-1 text-sm text-stone-200 hover:text-white disabled:opacity-30 transition-colors"
              >
                {step === 'welcome' ? 'Get Started' : 'Next'}
                <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default Onboarding;
