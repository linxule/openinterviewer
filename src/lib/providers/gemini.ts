import { GoogleGenAI } from '@google/genai';
import {
  AIProvider,
  buildInterviewSystemPrompt,
  cleanJSON,
  DEFAULT_EXECUTION_POLICY,
  type ProviderExecutionPolicy,
  type ProviderResult,
} from '../ai';
import type { EffectiveTransport, ProviderEndpoint } from './endpoint';
import {
  buildAggregateSynthesisPrompt,
  buildGreetingPrompt,
  buildSynthesisPrompt,
} from '../prompts';
import {
  type AggregateSynthesisResult,
  type AIInterviewResponse,
  type BehaviorData,
  DEFAULT_GEMINI_MODEL,
  type InterviewMessage,
  type ParticipantProfile,
  type QuestionProgress,
  type StudyConfig,
  type SynthesisResult,
} from '@/types';
import {
  ProviderFailure,
  ProviderTimeoutError,
  logProviderFailure,
  providerCallError,
  withProviderDeadline,
} from '../providerErrors';
import {
  validateAggregateSynthesisPayload,
  validateFollowupStudy,
  validateInterviewResponse,
  validateSynthesisResult,
  type FollowupStudy,
} from '../providerValidation';
import {
  aggregateSynthesisResponseSchema,
  followupStudyResponseSchema,
  interviewResponseSchema,
  synthesisResponseSchema,
  type ProviderJsonSchema,
} from '../providerSchemas';
import {
  buildFollowupPrompt,
  execution,
  formatInterviewHistory,
  GREETING_DEADLINE_MS,
  INTERVIEW_DEADLINE_MS,
  isQueuedSynthesis,
  providerResult,
  SYNTHESIS_DEADLINE_MS,
  synthesisDeadlineMs,
  type AggregateSynthesisPayload,
} from './shared';
import { isKnownProviderModel } from '../providerRegistry';
import { resolveSynthesisModel } from './synthesisModel';

type GeminiThinkingLevel = 'low' | 'high';

export function getGeminiInteractionThinkingLevel(
  enableReasoning?: boolean,
): GeminiThinkingLevel | undefined {
  if (enableReasoning === undefined) return undefined;
  return enableReasoning ? 'high' : 'low';
}

// Gemini's Interactions API response_format.schema rejects these JSON Schema
// keywords (maxItems confirmed by live bisect 2026-09-05 on gemini-3.8-flash)
// keywords with a 400 (`Request contains an invalid argument`), even though
// they are valid JSON Schema and accepted by every other provider adapter.
// All three bounds are re-enforced server-side by src/lib/providerValidation.ts,
// so stripping them from the WIRE schema Gemini sees loses no safety — only
// this adapter's outbound request is affected; the shared schemas in
// src/lib/providerSchemas.ts stay strict for every other provider.
const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = ['maxLength', 'minimum', 'minItems', 'maxItems'] as const;

export function toGeminiResponseSchema(schema: ProviderJsonSchema): ProviderJsonSchema {
  function strip(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if ((GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key)) continue;
        result[key] = strip(entry);
      }
      return result;
    }
    return value;
  }
  return strip(schema) as ProviderJsonSchema;
}

export class GeminiProvider implements AIProvider {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly transport: EffectiveTransport;

  /**
   * `endpoint` (Cloudflare target): the Gemini API (never Vertex), a fixed
   * API version and an explicit base URL and headers, so no SDK environment
   * default is ever read. Without it, construction is unchanged.
   */
  constructor(model?: string, apiKey?: string | null, endpoint?: ProviderEndpoint) {
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is required');

    this.transport = endpoint?.transport ?? 'direct';
    this.ai = endpoint
      ? new GoogleGenAI({
        apiKey: key,
        vertexai: false,
        apiVersion: 'v1beta',
        httpOptions: {
          baseUrl: endpoint.baseURL,
          ...(Object.keys(endpoint.headers).length > 0 ? { headers: { ...endpoint.headers } } : {}),
        },
      })
      : new GoogleGenAI({ apiKey: key });
    this.model = model
      || process.env.GEMINI_MODEL
      || process.env.AI_MODEL
      || DEFAULT_GEMINI_MODEL;
    if (!isKnownProviderModel('gemini', this.model)) {
      throw new Error(`Unsupported Gemini model: ${this.model}`);
    }
  }

  private async createInteraction(options: {
    model: string;
    input: string;
    systemInstruction?: string;
    schema?: ProviderJsonSchema;
    enableReasoning?: boolean;
    deadlineMs: number;
    operation: string;
    policy?: ProviderExecutionPolicy;
  }) {
    const thinkingLevel = getGeminiInteractionThinkingLevel(options.enableReasoning);

    try {
      return await withProviderDeadline(options.deadlineMs, (signal) =>
        this.ai.interactions.create({
          model: options.model,
          input: options.input,
          store: false,
          ...(options.systemInstruction
            ? { system_instruction: options.systemInstruction }
            : {}),
          ...(options.schema
            ? {
                response_format: {
                  type: 'text' as const,
                  mime_type: 'application/json' as const,
                  schema: toGeminiResponseSchema(options.schema),
                },
              }
            : {}),
          ...(thinkingLevel
            ? { generation_config: { thinking_level: thinkingLevel } }
            : {}),
        }, {
          timeout: options.deadlineMs,
          fetchOptions: { signal },
          // @google/genai 2.22.0 Interactions per-call maxRetries: the bridge maps
          // it to retries.maxRetries, and 0 permits a single attempt.
          ...(isQueuedSynthesis(options.policy) ? { maxRetries: 0 } : {}),
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('gemini', options.operation, error);
    }
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string,
  ): Promise<AIInterviewResponse> {
    const response = await this.createInteraction({
      model: this.model,
      input: formatInterviewHistory(history) || 'PARTICIPANT: Please continue the interview.',
      systemInstruction: buildInterviewSystemPrompt(
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
      ),
      schema: interviewResponseSchema,
      enableReasoning: studyConfig.enableReasoning,
      deadlineMs: INTERVIEW_DEADLINE_MS,
      operation: 'interview',
    });

    return this.parseStructured(response.output_text, 'interview', validateInterviewResponse);
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const response = await this.createInteraction({
      model: this.model,
      input: buildGreetingPrompt(studyConfig),
      deadlineMs: GREETING_DEADLINE_MS,
      operation: 'greeting',
    });
    if (!response.output_text?.trim()) {
      throw new ProviderFailure('invalid-response', 'Gemini greeting returned no text');
    }
    return response.output_text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null,
    policy: ProviderExecutionPolicy = DEFAULT_EXECUTION_POLICY,
  ): Promise<ProviderResult<SynthesisResult>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createInteraction({
      model: requestedModel,
      input: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      schema: synthesisResponseSchema,
      enableReasoning: studyConfig.enableReasoning ?? true,
      deadlineMs: synthesisDeadlineMs(policy),
      operation: 'synthesis',
      policy,
    });
    const value = this.parseStructured(response.output_text, 'synthesis', validateSynthesisResult);
    return providerResult(value, execution('gemini', requestedModel, response.model, undefined, this.transport));
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createInteraction({
      model: requestedModel,
      input: buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount),
      schema: aggregateSynthesisResponseSchema,
      enableReasoning: studyConfig.enableReasoning ?? true,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'aggregate-synthesis',
    });
    const value = this.parseStructured(
      response.output_text,
      'aggregate-synthesis',
      validateAggregateSynthesisPayload,
    );
    return providerResult(value, execution('gemini', requestedModel, response.model, undefined, this.transport));
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const requestedModel = resolveSynthesisModel(parentConfig);
    const response = await this.createInteraction({
      model: requestedModel,
      input: buildFollowupPrompt(parentConfig, synthesis),
      schema: followupStudyResponseSchema,
      enableReasoning: parentConfig.enableReasoning ?? true,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    const value = this.parseStructured(response.output_text, 'follow-up', validateFollowupStudy);
    return providerResult(value, execution('gemini', requestedModel, response.model, undefined, this.transport));
  }

  private parseStructured<T>(
    text: string | undefined,
    operation: string,
    validate: (input: unknown) => T,
  ): T {
    if (!text) {
      throw new ProviderFailure('invalid-response', `Gemini ${operation} returned no text`);
    }
    try {
      return validate(JSON.parse(cleanJSON(text)));
    } catch (error) {
      logProviderFailure('gemini', `${operation}-parse`, error);
      throw new ProviderFailure(
        'invalid-response',
        `Gemini ${operation} returned unparseable or malformed JSON`,
        error,
      );
    }
  }
}
