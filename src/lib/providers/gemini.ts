import { GoogleGenAI } from '@google/genai';
import {
  AIProvider,
  buildInterviewSystemPrompt,
  cleanJSON,
  type ProviderResult,
} from '../ai';
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
  GEMINI_SYNTHESIS_MODEL,
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
  providerResult,
  SYNTHESIS_DEADLINE_MS,
  type AggregateSynthesisPayload,
} from './shared';
import { isKnownProviderModel } from '../providerRegistry';

type GeminiThinkingLevel = 'low' | 'high';

export function getGeminiInteractionThinkingLevel(
  enableReasoning?: boolean,
): GeminiThinkingLevel | undefined {
  if (enableReasoning === undefined) return undefined;
  return enableReasoning ? 'high' : 'low';
}

// Gemini's Interactions API response_format.schema rejects these JSON Schema
// keywords with a 400 (`Request contains an invalid argument`), even though
// they are valid JSON Schema and accepted by every other provider adapter.
// All three bounds are re-enforced server-side by src/lib/providerValidation.ts,
// so stripping them from the WIRE schema Gemini sees loses no safety — only
// this adapter's outbound request is affected; the shared schemas in
// src/lib/providerSchemas.ts stay strict for every other provider.
const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = ['maxLength', 'minimum', 'minItems'] as const;

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

  constructor(model?: string, apiKey?: string | null) {
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is required');

    this.ai = new GoogleGenAI({ apiKey: key });
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
  ): Promise<ProviderResult<SynthesisResult>> {
    const requestedModel = GEMINI_SYNTHESIS_MODEL;
    const response = await this.createInteraction({
      model: requestedModel,
      input: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      schema: synthesisResponseSchema,
      enableReasoning: studyConfig.enableReasoning ?? true,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'synthesis',
    });
    const value = this.parseStructured(response.output_text, 'synthesis', validateSynthesisResult);
    return providerResult(value, execution('gemini', requestedModel, response.model));
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const requestedModel = GEMINI_SYNTHESIS_MODEL;
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
    return providerResult(value, execution('gemini', requestedModel, response.model));
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const requestedModel = GEMINI_SYNTHESIS_MODEL;
    const response = await this.createInteraction({
      model: requestedModel,
      input: buildFollowupPrompt(parentConfig, synthesis),
      schema: followupStudyResponseSchema,
      enableReasoning: parentConfig.enableReasoning ?? true,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    const value = this.parseStructured(response.output_text, 'follow-up', validateFollowupStudy);
    return providerResult(value, execution('gemini', requestedModel, response.model));
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
