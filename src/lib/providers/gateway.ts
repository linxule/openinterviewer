import {
  Output,
  gateway,
  generateText,
  jsonSchema,
  type GatewayModelId,
} from 'ai';
import type {
  AIProvider,
  ProviderResult,
} from '../ai';
import { buildInterviewSystemPrompt } from '../ai';
import {
  buildAggregateSynthesisPrompt,
  buildGreetingPrompt,
  buildSynthesisPrompt,
} from '../prompts';
import type {
  AggregateSynthesisResult,
  AIInterviewResponse,
  BehaviorData,
  InterviewMessage,
  ParticipantProfile,
  QuestionProgress,
  StudyConfig,
  SynthesisResult,
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
import {
  gatewayRouteForProvider,
  isGatewayAuthConfigured,
  toGatewayModelId,
  type GatewayProviderType,
} from '../aiTransport';

type DomainValidator<T> = (input: unknown) => T;

function gatewayProviderOptions(provider: GatewayProviderType) {
  return {
    only: [gatewayRouteForProvider(provider)],
    disallowPromptTraining: true,
    ...(process.env.AI_GATEWAY_ZERO_DATA_RETENTION === 'true'
      ? { zeroDataRetention: true }
      : {}),
  };
}

export class GatewayProvider implements AIProvider {
  private readonly provider: GatewayProviderType;
  private readonly model: string;

  constructor(provider: GatewayProviderType, model: string) {
    if (!isGatewayAuthConfigured()) {
      throw new Error('Vercel AI Gateway authentication is required');
    }
    if (!isKnownProviderModel(provider, model)) {
      throw new Error(`Unsupported ${provider} model: ${model}`);
    }
    this.provider = provider;
    this.model = model;
  }

  private async createText(options: {
    model: string;
    prompt: string;
    system?: string;
    maxOutputTokens: number;
    deadlineMs: number;
    operation: string;
  }) {
    const gatewayModel = toGatewayModelId(this.provider, options.model);
    try {
      const result = await withProviderDeadline(options.deadlineMs, (signal) =>
        generateText({
          model: gateway(gatewayModel as GatewayModelId),
          prompt: options.prompt,
          ...(options.system ? { system: options.system } : {}),
          maxOutputTokens: options.maxOutputTokens,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: {
            gateway: gatewayProviderOptions(this.provider),
          },
        })
      );
      return { text: result.text, responseModel: result.response.modelId, gatewayModel };
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('gateway', options.operation, error);
    }
  }

  private async createStructured<T>(options: {
    model: string;
    prompt: string;
    system?: string;
    schema: ProviderJsonSchema;
    validate: DomainValidator<T>;
    maxOutputTokens: number;
    deadlineMs: number;
    operation: string;
  }): Promise<{ value: T; responseModel: string; gatewayModel: string }> {
    const gatewayModel = toGatewayModelId(this.provider, options.model);
    let result;
    try {
      result = await withProviderDeadline(options.deadlineMs, (signal) =>
        generateText({
          model: gateway(gatewayModel as GatewayModelId),
          prompt: options.prompt,
          ...(options.system ? { system: options.system } : {}),
          output: Output.object({
            schema: jsonSchema(options.schema as Parameters<typeof jsonSchema>[0]),
          }),
          maxOutputTokens: options.maxOutputTokens,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: {
            gateway: gatewayProviderOptions(this.provider),
          },
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('gateway', options.operation, error);
    }

    try {
      const responseModel = result.response.modelId?.trim();
      if (!responseModel) {
        throw new Error('Gateway response omitted its resolved model');
      }
      return {
        value: options.validate(result.output),
        responseModel,
        gatewayModel,
      };
    } catch (error) {
      logProviderFailure('gateway', `${options.operation}-parse`, error);
      throw new ProviderFailure(
        'invalid-response',
        `Vercel AI Gateway ${options.operation} returned malformed structured output`,
        error,
      );
    }
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string,
  ): Promise<AIInterviewResponse> {
    const response = await this.createStructured({
      model: this.model,
      prompt: formatInterviewHistory(history) || 'PARTICIPANT: Please continue the interview.',
      system: buildInterviewSystemPrompt(
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
      ),
      schema: interviewResponseSchema,
      validate: validateInterviewResponse,
      maxOutputTokens: 4096,
      deadlineMs: INTERVIEW_DEADLINE_MS,
      operation: 'interview',
    });
    return response.value;
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const response = await this.createText({
      model: this.model,
      prompt: buildGreetingPrompt(studyConfig),
      maxOutputTokens: 500,
      deadlineMs: GREETING_DEADLINE_MS,
      operation: 'greeting',
    });
    if (!response.text.trim()) {
      throw new ProviderFailure('invalid-response', 'Vercel AI Gateway greeting returned no text');
    }
    return response.text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null,
  ): Promise<ProviderResult<SynthesisResult>> {
    const response = await this.createStructured({
      model: resolveSynthesisModel(studyConfig),
      prompt: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      schema: synthesisResponseSchema,
      validate: validateSynthesisResult,
      maxOutputTokens: 8192,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'synthesis',
    });
    return providerResult(
      response.value,
      execution(
        this.provider,
        response.gatewayModel,
        response.responseModel,
        gatewayRouteForProvider(this.provider),
      ),
    );
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const response = await this.createStructured({
      model: resolveSynthesisModel(studyConfig),
      prompt: buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount),
      schema: aggregateSynthesisResponseSchema,
      validate: validateAggregateSynthesisPayload,
      maxOutputTokens: 12_000,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'aggregate-synthesis',
    });
    return providerResult(
      response.value,
      execution(
        this.provider,
        response.gatewayModel,
        response.responseModel,
        gatewayRouteForProvider(this.provider),
      ),
    );
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const response = await this.createStructured({
      model: resolveSynthesisModel(parentConfig),
      prompt: buildFollowupPrompt(parentConfig, synthesis),
      schema: followupStudyResponseSchema,
      validate: validateFollowupStudy,
      maxOutputTokens: 4096,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    return providerResult(
      response.value,
      execution(
        this.provider,
        response.gatewayModel,
        response.responseModel,
        gatewayRouteForProvider(this.provider),
      ),
    );
  }
}
