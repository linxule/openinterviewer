import OpenAI from 'openai';
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
  DEFAULT_OPENAI_MODEL,
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
import { resolveSynthesisModel } from './synthesisModel';

export function getOpenAIReasoning(
  enableReasoning?: boolean,
): OpenAI.Responses.ResponseCreateParams['reasoning'] {
  if (enableReasoning === undefined) return undefined;
  return { effort: enableReasoning ? 'medium' : 'none' };
}

export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(model?: string, apiKey?: string | null) {
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is required for OpenAI provider');

    this.client = new OpenAI({ apiKey: key });
    this.model = model
      || process.env.OPENAI_MODEL
      || process.env.AI_MODEL
      || DEFAULT_OPENAI_MODEL;
    if (!isKnownProviderModel('openai', this.model)) {
      throw new Error(`Unsupported OpenAI model: ${this.model}`);
    }
  }

  private async createResponse(options: {
    model: string;
    input: string;
    instructions?: string;
    schema?: ProviderJsonSchema;
    schemaName?: string;
    enableReasoning?: boolean;
    maxOutputTokens: number;
    deadlineMs: number;
    operation: string;
  }) {
    try {
      return await withProviderDeadline(options.deadlineMs, (signal) =>
        this.client.responses.create({
          model: options.model,
          input: options.input,
          store: false,
          max_output_tokens: options.maxOutputTokens,
          ...(options.instructions ? { instructions: options.instructions } : {}),
          ...(options.schema
            ? {
                text: {
                  format: {
                    type: 'json_schema' as const,
                    name: options.schemaName || 'openinterviewer_response',
                    schema: options.schema,
                    strict: true,
                  },
                },
              }
            : {}),
          ...(getOpenAIReasoning(options.enableReasoning)
            ? { reasoning: getOpenAIReasoning(options.enableReasoning) }
            : {}),
        }, {
          signal,
          timeout: options.deadlineMs,
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('openai', options.operation, error);
    }
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string,
  ): Promise<AIInterviewResponse> {
    const response = await this.createResponse({
      model: this.model,
      input: formatInterviewHistory(history) || 'PARTICIPANT: Please continue the interview.',
      instructions: buildInterviewSystemPrompt(
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
      ),
      schema: interviewResponseSchema,
      schemaName: 'interview_response',
      enableReasoning: studyConfig.enableReasoning,
      maxOutputTokens: 4096,
      deadlineMs: INTERVIEW_DEADLINE_MS,
      operation: 'interview',
    });
    return this.parseStructured(response.output_text, 'interview', validateInterviewResponse);
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const response = await this.createResponse({
      model: this.model,
      input: buildGreetingPrompt(studyConfig),
      maxOutputTokens: 500,
      deadlineMs: GREETING_DEADLINE_MS,
      operation: 'greeting',
    });
    if (!response.output_text?.trim()) {
      throw new ProviderFailure('invalid-response', 'OpenAI greeting returned no text');
    }
    return response.output_text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null,
  ): Promise<ProviderResult<SynthesisResult>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createResponse({
      model: requestedModel,
      input: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      schema: synthesisResponseSchema,
      schemaName: 'interview_synthesis',
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxOutputTokens: 8192,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'synthesis',
    });
    const value = this.parseStructured(response.output_text, 'synthesis', validateSynthesisResult);
    return providerResult(value, execution('openai', requestedModel, response.model));
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createResponse({
      model: requestedModel,
      input: buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount),
      schema: aggregateSynthesisResponseSchema,
      schemaName: 'aggregate_synthesis',
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxOutputTokens: 12_000,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'aggregate-synthesis',
    });
    const value = this.parseStructured(
      response.output_text,
      'aggregate-synthesis',
      validateAggregateSynthesisPayload,
    );
    return providerResult(value, execution('openai', requestedModel, response.model));
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const requestedModel = resolveSynthesisModel(parentConfig);
    const response = await this.createResponse({
      model: requestedModel,
      input: buildFollowupPrompt(parentConfig, synthesis),
      schema: followupStudyResponseSchema,
      schemaName: 'followup_study',
      enableReasoning: parentConfig.enableReasoning ?? true,
      maxOutputTokens: 4096,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    const value = this.parseStructured(response.output_text, 'follow-up', validateFollowupStudy);
    return providerResult(value, execution('openai', requestedModel, response.model));
  }

  private parseStructured<T>(
    text: string | undefined,
    operation: string,
    validate: (input: unknown) => T,
  ): T {
    if (!text) throw new ProviderFailure('invalid-response', `OpenAI ${operation} returned no text`);

    try {
      return validate(JSON.parse(cleanJSON(text)));
    } catch (error) {
      logProviderFailure('openai', `${operation}-parse`, error);
      throw new ProviderFailure(
        'invalid-response',
        `OpenAI ${operation} returned unparseable or malformed JSON`,
        error,
      );
    }
  }
}
