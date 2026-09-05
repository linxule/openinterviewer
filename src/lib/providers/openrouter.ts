import { OpenRouter } from '@openrouter/sdk';
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
  DEFAULT_OPENROUTER_MODEL,
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

const ROUTING_POLICY = {
  requireParameters: true,
  dataCollection: 'deny' as const,
  zdr: true,
  allowFallbacks: false,
};

type OpenRouterChatResponse = Awaited<ReturnType<OpenRouter['chat']['send']>> & {
  choices: Array<{ message: { content?: unknown; model?: string } }>;
  model: string;
  openrouterMetadata?: {
    attempts?: Array<{ provider: string; status: number }>;
  };
};

export class OpenRouterProvider implements AIProvider {
  private readonly client: OpenRouter;
  private readonly model: string;

  constructor(model?: string, apiKey?: string | null) {
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY is required for OpenRouter provider');

    this.client = new OpenRouter({ apiKey: key, appTitle: 'OpenInterviewer' });
    this.model = model
      || process.env.OPENROUTER_MODEL
      || process.env.AI_MODEL
      || DEFAULT_OPENROUTER_MODEL;
    if (!isKnownProviderModel('openrouter', this.model)) {
      throw new Error(`Unsupported OpenRouter model: ${this.model}`);
    }
  }

  private async send(options: {
    model: string;
    input: string;
    system?: string;
    schema?: ProviderJsonSchema;
    schemaName?: string;
    enableReasoning?: boolean;
    maxCompletionTokens: number;
    deadlineMs: number;
    operation: string;
  }): Promise<OpenRouterChatResponse> {
    const messages = [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      { role: 'user' as const, content: options.input },
    ];

    try {
      const response = await withProviderDeadline(options.deadlineMs, (signal) =>
        this.client.chat.send({
          xOpenRouterMetadata: 'enabled',
          chatRequest: {
            model: options.model,
            messages,
            stream: false,
            maxCompletionTokens: options.maxCompletionTokens,
            provider: ROUTING_POLICY,
            ...(options.enableReasoning !== undefined
              ? { reasoning: { effort: options.enableReasoning ? 'medium' as const : 'none' as const } }
              : {}),
            ...(options.schema
              ? {
                  responseFormat: {
                    type: 'json_schema' as const,
                    jsonSchema: {
                      name: options.schemaName || 'openinterviewer_response',
                      schema: options.schema,
                      strict: true,
                    },
                  },
                }
              : {}),
          },
        }, { signal, timeoutMs: options.deadlineMs })
      );
      if (!('choices' in response)) {
        throw new ProviderFailure('invalid-response', 'OpenRouter returned a stream unexpectedly');
      }
      return response as OpenRouterChatResponse;
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('openrouter', options.operation, error);
    }
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string,
  ): Promise<AIInterviewResponse> {
    const response = await this.send({
      model: this.model,
      input: formatInterviewHistory(history) || 'PARTICIPANT: Please continue the interview.',
      system: buildInterviewSystemPrompt(
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
      ),
      schema: interviewResponseSchema,
      schemaName: 'interview_response',
      enableReasoning: studyConfig.enableReasoning,
      maxCompletionTokens: 4096,
      deadlineMs: INTERVIEW_DEADLINE_MS,
      operation: 'interview',
    });
    return this.parseStructured(response, 'interview', validateInterviewResponse);
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const response = await this.send({
      model: this.model,
      input: buildGreetingPrompt(studyConfig),
      maxCompletionTokens: 500,
      deadlineMs: GREETING_DEADLINE_MS,
      operation: 'greeting',
    });
    const text = this.responseText(response);
    if (!text) throw new ProviderFailure('invalid-response', 'OpenRouter greeting returned no text');
    return text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null,
  ): Promise<ProviderResult<SynthesisResult>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.send({
      model: requestedModel,
      input: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      schema: synthesisResponseSchema,
      schemaName: 'interview_synthesis',
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxCompletionTokens: 8192,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'synthesis',
    });
    const value = this.parseStructured(response, 'synthesis', validateSynthesisResult);
    return providerResult(value, this.executionFor(response, requestedModel));
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.send({
      model: requestedModel,
      input: buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount),
      schema: aggregateSynthesisResponseSchema,
      schemaName: 'aggregate_synthesis',
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxCompletionTokens: 12_000,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'aggregate-synthesis',
    });
    const value = this.parseStructured(
      response,
      'aggregate-synthesis',
      validateAggregateSynthesisPayload,
    );
    return providerResult(value, this.executionFor(response, requestedModel));
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const requestedModel = resolveSynthesisModel(parentConfig);
    const response = await this.send({
      model: requestedModel,
      input: buildFollowupPrompt(parentConfig, synthesis),
      schema: followupStudyResponseSchema,
      schemaName: 'followup_study',
      enableReasoning: parentConfig.enableReasoning ?? true,
      maxCompletionTokens: 4096,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    const value = this.parseStructured(response, 'follow-up', validateFollowupStudy);
    return providerResult(value, this.executionFor(response, requestedModel));
  }

  private responseText(response: OpenRouterChatResponse): string | undefined {
    const content = response.choices[0]?.message.content;
    return typeof content === 'string' ? content : undefined;
  }

  private executionFor(response: OpenRouterChatResponse, requestedModel: string) {
    const routedAttempt = response.openrouterMetadata?.attempts
      ?.findLast((attempt) => attempt.status >= 200 && attempt.status < 300);
    const resolvedModel = response.choices[0]?.message.model || response.model;
    if (!routedAttempt?.provider?.trim()) {
      throw new ProviderFailure(
        'invalid-response',
        'OpenRouter response did not identify the upstream provider',
      );
    }
    return execution('openrouter', requestedModel, resolvedModel, routedAttempt.provider);
  }

  private parseStructured<T>(
    response: OpenRouterChatResponse,
    operation: string,
    validate: (input: unknown) => T,
  ): T {
    const text = this.responseText(response);
    if (!text) {
      throw new ProviderFailure('invalid-response', `OpenRouter ${operation} returned no text`);
    }
    try {
      return validate(JSON.parse(cleanJSON(text)));
    } catch (error) {
      logProviderFailure('openrouter', `${operation}-parse`, error);
      throw new ProviderFailure(
        'invalid-response',
        `OpenRouter ${operation} returned unparseable or malformed JSON`,
        error,
      );
    }
  }
}
