import { Coordinate, Field, Notice } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AIModelOption, AIProviderType } from '@/types';
import { Section } from './Section';
import type { ConfigStatus } from './providerStatus';
import type { StudyDraft } from './useStudyDraft';

export interface ProviderSectionProps {
  draft: StudyDraft;
  editing: boolean;
  onEdit: () => void;
  configStatus: ConfigStatus | null;
  configStatusError: string | null;
  isAuthenticated: boolean | null;
  selectedProviderConfigured: boolean;
  selectedModelValid: boolean;
  providerOptions: ReadonlyArray<{ id: AIProviderType; label: string; desc: string }>;
  selectedProviderName: string;
  selectedProviderEnvName: string;
  selectedProviderModels: readonly AIModelOption[];
  isCustomOpenRouterModel: boolean;
  onOpenSettings: () => void;
  onOpenSelfHost: () => void;
}

function NoProviderConfiguredNotice({ providerOptions }: { providerOptions: ReadonlyArray<unknown> }) {
  if (providerOptions.length !== 0) return null;
  return (
    <Notice tone="error" eyebrow="No provider configured">
      <p className="mt-1 text-[13px] text-ink-700">
        No AI provider keys are configured for this hosted account. Add one in Account &amp; connections.
      </p>
    </Notice>
  );
}

function InvalidModelNotice({ selectedModelValid, aiProvider, selectedProviderName }: {
  selectedModelValid: boolean;
  aiProvider: AIProviderType;
  selectedProviderName: string;
}) {
  if (selectedModelValid) return null;
  return (
    <Notice tone="error" role="alert">
      <p className="text-[13px] text-ink-700">
        {aiProvider === 'openrouter'
          ? 'Enter a valid OpenRouter provider/model slug. Automatic routing is not supported.'
          : `Choose a supported ${selectedProviderName} model.`}
      </p>
    </Notice>
  );
}

function CheckingProvidersNotice({ isAuthenticated, configStatus, configStatusError }: {
  isAuthenticated: boolean | null;
  configStatus: ConfigStatus | null;
  configStatusError: string | null;
}) {
  if (!(isAuthenticated === true && !configStatus && !configStatusError)) return null;
  return (
    <Notice tone="neutral" role="status">
      <p className="text-[13px] text-ink-700">Checking configured AI providers…</p>
    </Notice>
  );
}

function ProviderUnavailableNotice({
  isAuthenticated,
  configStatus,
  configStatusError,
  selectedProviderConfigured,
  selectedProviderName,
  selectedProviderEnvName,
  onOpenSettings,
  onOpenSelfHost,
}: {
  isAuthenticated: boolean | null;
  configStatus: ConfigStatus | null;
  configStatusError: string | null;
  selectedProviderConfigured: boolean;
  selectedProviderName: string;
  selectedProviderEnvName: string;
  onOpenSettings: () => void;
  onOpenSelfHost: () => void;
}) {
  if (!(isAuthenticated === true && (configStatusError || (configStatus && !selectedProviderConfigured)))) return null;
  return (
    <Notice tone="error" role="alert">
      <h4 className="text-[13px] font-semibold text-ink-900">
        {configStatusError ? 'Provider availability could not be verified' : `${selectedProviderName} is not available`}
      </h4>
      <p className="mt-1 text-[13px] text-ink-700">
        {configStatusError
          ? configStatusError
          : configStatus?.aiTransport === 'gateway'
            ? `${selectedProviderName} is not enabled for this Vercel AI Gateway deployment. Choose Gemini, Claude, or OpenAI.`
          : configStatus?.mode === 'hosted'
            ? `This account does not have a ${selectedProviderName} key. Add one in Account & connections or finish onboarding before saving or sharing this study.`
            : <>This deployment does not have <code className="font-mono text-ink-900">{selectedProviderEnvName}</code>. Add it server-side, run <code className="font-mono text-ink-900">npm run setup:check</code>, and redeploy before saving or sharing this study.</>}
      </p>
      {!configStatusError && configStatus?.mode === 'hosted' && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-3 font-sans text-[13px] font-medium text-action underline underline-offset-2"
        >
          Account &amp; connections
        </button>
      )}
      {!configStatusError && configStatus?.mode === 'standalone' && (
        <button
          type="button"
          onClick={onOpenSelfHost}
          className="mt-3 font-sans text-[13px] font-medium text-action underline underline-offset-2"
        >
          Open self-host setup guide
        </button>
      )}
    </Notice>
  );
}

export function ProviderSection({
  draft,
  editing,
  onEdit,
  configStatus,
  configStatusError,
  isAuthenticated,
  selectedProviderConfigured,
  selectedModelValid,
  providerOptions,
  selectedProviderName,
  selectedProviderEnvName,
  selectedProviderModels,
  isCustomOpenRouterModel,
  onOpenSettings,
  onOpenSelfHost,
}: ProviderSectionProps) {
  const showReasoningControl = draft.aiProvider === 'gemini' && configStatus?.aiTransport !== 'gateway';

  // The four fail-closed status blocks are not editing affordances (M5.6):
  // they render byte-identically in both read and edit mode.
  const statusBlocks = (
    <>
      <NoProviderConfiguredNotice providerOptions={providerOptions} />
      <InvalidModelNotice
        selectedModelValid={selectedModelValid}
        aiProvider={draft.aiProvider}
        selectedProviderName={selectedProviderName}
      />
      <CheckingProvidersNotice
        isAuthenticated={isAuthenticated}
        configStatus={configStatus}
        configStatusError={configStatusError}
      />
      <ProviderUnavailableNotice
        isAuthenticated={isAuthenticated}
        configStatus={configStatus}
        configStatusError={configStatusError}
        selectedProviderConfigured={selectedProviderConfigured}
        selectedProviderName={selectedProviderName}
        selectedProviderEnvName={selectedProviderEnvName}
        onOpenSettings={onOpenSettings}
        onOpenSelfHost={onOpenSelfHost}
      />
    </>
  );

  return (
    <Section
      id="ai-provider"
      label="AI Provider"
      editing={editing}
      onEdit={onEdit}
      description={
        <>
          Choose which AI model powers your interviews
          {configStatus?.aiTransport === 'gateway' ? ' through Vercel AI Gateway.' : '.'}
        </>
      }
      read={
        <div className="space-y-2">
          <Coordinate className="block">{selectedProviderName} · {draft.aiModel}</Coordinate>
          {showReasoningControl ? (
            <Coordinate className="block">
              reasoning: {draft.enableReasoning === undefined ? 'automatic' : draft.enableReasoning ? 'more thinking' : 'minimize thinking'}
            </Coordinate>
          ) : null}
          {statusBlocks}
        </div>
      }
    >
      <div className="space-y-2">
        <NoProviderConfiguredNotice providerOptions={providerOptions} />
        {providerOptions.map((option) => {
          const selected = draft.aiProvider === option.id;
          return (
            <label
              key={option.id}
              className={cn(
                'flex cursor-pointer items-start gap-3 border-l-2 py-3 pl-4',
                selected ? 'border-l-action bg-paper-2' : 'border-l-transparent hover:bg-paper-2/50'
              )}
            >
              <input
                type="radio"
                name="aiProvider"
                checked={selected}
                onChange={() => draft.selectProvider(option.id)}
                className="mt-1 accent-action"
              />
              <div>
                <div className="font-sans text-[15px] font-medium text-ink-900">{option.label}</div>
                <div className="font-sans text-[13px] text-ink-500">{option.desc}</div>
                {option.id === 'openrouter' ? (
                  <div className="mt-1 font-sans text-[13px] text-ink-500">
                    Requests go to OpenRouter and a ZDR-compatible upstream inference provider selected for the model.
                  </div>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>

      {/* Model Selection */}
      <Field
        label="Model"
        htmlFor="study-ai-model"
        hint={
          selectedProviderModels.find(model => model.id === draft.aiModel)?.desc
            || (isCustomOpenRouterModel
              ? 'Custom OpenRouter model; privacy and structured-output requirements still fail closed at request time.'
              : '')
        }
      >
        <select
          value={isCustomOpenRouterModel ? '__custom__' : draft.aiModel}
          onChange={(event) => {
            draft.setAiModel(event.target.value === '__custom__' ? '' : event.target.value);
          }}
          className="w-full"
        >
          {selectedProviderModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          {draft.aiProvider === 'openrouter' ? <option value="__custom__">Custom provider/model ID…</option> : null}
        </select>
      </Field>

      {draft.aiProvider === 'openrouter' && isCustomOpenRouterModel ? (
        <div className="space-y-1">
          <label
            htmlFor="study-openrouter-custom-model"
            className="font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-500"
          >
            OpenRouter model ID
          </label>
          <input
            id="study-openrouter-custom-model"
            type="text"
            value={draft.aiModel}
            maxLength={200}
            onChange={(event) => draft.setAiModel(event.target.value)}
            aria-invalid={!selectedModelValid}
            aria-describedby="study-openrouter-model-help"
            placeholder="provider/model"
            autoComplete="off"
            className="w-full bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans"
          />
          <p
            id="study-openrouter-model-help"
            className="text-[13px] text-ink-500"
          >
            Use a provider/model slug of at most 200 characters. Automatic routing is not supported.
          </p>
        </div>
      ) : null}

      {/* Keep the legacy reasoning control Gemini-only until the stored
          study contract supports provider-specific reasoning options. */}
      {showReasoningControl && (
        <Field
          label="AI Reasoning Mode"
          htmlFor="study-reasoning-mode"
          hint="Automatic lets Gemini choose a supported interview budget and uses high thinking for synthesis. Minimize uses each model's lowest supported interview setting and the synthesis model's low setting."
        >
          <select
            value={draft.enableReasoning === undefined ? 'auto' : draft.enableReasoning ? 'on' : 'off'}
            onChange={(e) => {
              const v = e.target.value;
              draft.setEnableReasoning(v === 'auto' ? undefined : v === 'on');
            }}
            className="w-full"
          >
            <option value="auto">Automatic (recommended)</option>
            <option value="on">More thinking</option>
            <option value="off">Minimize thinking</option>
          </select>
        </Field>
      )}

      <InvalidModelNotice
        selectedModelValid={selectedModelValid}
        aiProvider={draft.aiProvider}
        selectedProviderName={selectedProviderName}
      />
      <CheckingProvidersNotice
        isAuthenticated={isAuthenticated}
        configStatus={configStatus}
        configStatusError={configStatusError}
      />
      <ProviderUnavailableNotice
        isAuthenticated={isAuthenticated}
        configStatus={configStatus}
        configStatusError={configStatusError}
        selectedProviderConfigured={selectedProviderConfigured}
        selectedProviderName={selectedProviderName}
        selectedProviderEnvName={selectedProviderEnvName}
        onOpenSettings={onOpenSettings}
        onOpenSelfHost={onOpenSelfHost}
      />
    </Section>
  );
}
