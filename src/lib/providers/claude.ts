import Anthropic from '@anthropic-ai/sdk';
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
  DEFAULT_CLAUDE_MODEL,
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
  GREETING_DEADLINE_MS,
  INTERVIEW_DEADLINE_MS,
  providerResult,
  SYNTHESIS_DEADLINE_MS,
  type AggregateSynthesisPayload,
} from './shared';
import { isKnownProviderModel } from '../providerRegistry';
import { resolveSynthesisModel } from './synthesisModel';

function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(?:sonnet|opus|fable|mythos)-5(?:$|-)/.test(model)
    || /^claude-(?:sonnet|opus)-4-[678](?:$|-)/.test(model);
}

export function getClaudeThinkingConfig(
  model: string,
  enableReasoning?: boolean,
): Anthropic.ThinkingConfigParam | undefined {
  if (enableReasoning === false) return { type: 'disabled' };
  if (supportsAdaptiveThinking(model)) return { type: 'adaptive', display: 'omitted' };
  return undefined;
}

export class ClaudeProvider implements AIProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model?: string, apiKey?: string | null) {
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is required for Claude provider');

    this.client = new Anthropic({ apiKey: key });
    this.model = model
      || process.env.CLAUDE_MODEL
      || process.env.AI_MODEL
      || DEFAULT_CLAUDE_MODEL;
    if (!isKnownProviderModel('claude', this.model)) {
      throw new Error(`Unsupported Claude model: ${this.model}`);
    }
  }

  private async createStructured(options: {
    model: string;
    messages: Anthropic.MessageParam[];
    schema: ProviderJsonSchema;
    system?: string;
    enableReasoning?: boolean;
    maxTokens: number;
    deadlineMs: number;
    operation: string;
  }) {
    const thinking = getClaudeThinkingConfig(options.model, options.enableReasoning);
    try {
      return await withProviderDeadline(options.deadlineMs, (signal) =>
        this.client.messages.create({
          model: options.model,
          max_tokens: options.maxTokens,
          messages: options.messages,
          ...(options.system ? { system: options.system } : {}),
          ...(thinking ? { thinking } : {}),
          output_config: {
            format: {
              type: 'json_schema',
              schema: options.schema,
            },
          },
        }, {
          signal,
          timeout: options.deadlineMs,
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('claude', options.operation, error);
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
      messages: this.toMessages(history),
      schema: interviewResponseSchema,
      system: buildInterviewSystemPrompt(
        studyConfig,
        participantProfile,
        questionProgress,
        currentContext,
      ),
      enableReasoning: studyConfig.enableReasoning,
      maxTokens: 4096,
      deadlineMs: INTERVIEW_DEADLINE_MS,
      operation: 'interview',
    });
    return this.parseStructured(response, 'interview', validateInterviewResponse);
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    let response;
    try {
      response = await withProviderDeadline(GREETING_DEADLINE_MS, (signal) =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 300,
          messages: [{ role: 'user', content: buildGreetingPrompt(studyConfig) }],
        }, {
          signal,
          timeout: GREETING_DEADLINE_MS,
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) throw error;
      throw providerCallError('claude', 'greeting', error);
    }

    const text = this.responseText(response);
    if (!text) throw new ProviderFailure('invalid-response', 'Claude greeting returned no text');
    return text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null,
  ): Promise<ProviderResult<SynthesisResult>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createStructured({
      model: requestedModel,
      messages: [{
        role: 'user',
        content: buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile),
      }],
      schema: synthesisResponseSchema,
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxTokens: 8192,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'synthesis',
    });
    const value = this.parseStructured(response, 'synthesis', validateSynthesisResult);
    return providerResult(value, execution('claude', requestedModel, response.model));
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number,
  ): Promise<ProviderResult<AggregateSynthesisPayload>> {
    const requestedModel = resolveSynthesisModel(studyConfig);
    const response = await this.createStructured({
      model: requestedModel,
      messages: [{
        role: 'user',
        content: buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount),
      }],
      schema: aggregateSynthesisResponseSchema,
      enableReasoning: studyConfig.enableReasoning ?? true,
      maxTokens: 12_000,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'aggregate-synthesis',
    });
    const value = this.parseStructured(
      response,
      'aggregate-synthesis',
      validateAggregateSynthesisPayload,
    );
    return providerResult(value, execution('claude', requestedModel, response.model));
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult,
  ): Promise<ProviderResult<FollowupStudy>> {
    const requestedModel = resolveSynthesisModel(parentConfig);
    const response = await this.createStructured({
      model: requestedModel,
      messages: [{ role: 'user', content: buildFollowupPrompt(parentConfig, synthesis) }],
      schema: followupStudyResponseSchema,
      enableReasoning: parentConfig.enableReasoning ?? true,
      maxTokens: 4096,
      deadlineMs: SYNTHESIS_DEADLINE_MS,
      operation: 'follow-up',
    });
    const value = this.parseStructured(response, 'follow-up', validateFollowupStudy);
    return providerResult(value, execution('claude', requestedModel, response.model));
  }

  private toMessages(history: InterviewMessage[]): Anthropic.MessageParam[] {
    if (history.length === 0) {
      return [{ role: 'user', content: 'Please continue the interview.' }];
    }
    return history.map((message) => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      content: message.role === 'system' ? `[System event] ${message.content}` : message.content,
    }));
  }

  private responseText(response: Anthropic.Message): string | undefined {
    return response.content.find((block) => block.type === 'text')?.text;
  }

  private parseStructured<T>(
    response: Anthropic.Message,
    operation: string,
    validate: (input: unknown) => T,
  ): T {
    const text = this.responseText(response);
    if (!text) throw new ProviderFailure('invalid-response', `Claude ${operation} returned no text`);

    try {
      return validate(JSON.parse(cleanJSON(text)));
    } catch (error) {
      logProviderFailure('claude', `${operation}-parse`, error);
      throw new ProviderFailure(
        'invalid-response',
        `Claude ${operation} returned unparseable or malformed JSON`,
        error,
      );
    }
  }
}
