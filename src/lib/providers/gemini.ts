// Gemini AI Provider Implementation
// Server-side only - uses API key from environment

import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import {
  AIProvider,
  buildInterviewSystemPrompt,
  cleanJSON
} from '../ai';
import {
  buildGreetingPrompt,
  buildSynthesisPrompt,
  buildAggregateSynthesisPrompt
} from '../prompts';
import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  SynthesisResult,
  BehaviorData,
  AIInterviewResponse,
  QuestionProgress,
  AggregateSynthesisResult,
  DEFAULT_GEMINI_MODEL,
  GEMINI_SYNTHESIS_MODEL
} from '@/types';
import {
  ProviderFailure,
  ProviderTimeoutError,
  logProviderFailure,
  providerCallError,
  withProviderDeadline
} from '../providerErrors';
import {
  validateAggregateSynthesisPayload,
  validateFollowupStudy,
  validateInterviewResponse,
  validateSynthesisResult
} from '../providerValidation';

// Thinking budget for 2.5 models (16K tokens)
const THINKING_BUDGET_25 = 16384;

// Deadlines for provider calls (ms). SDK-native timeouts are set alongside the
// AbortSignal so a request cannot hang even if the signal is ignored.
const GREETING_DEADLINE_MS = 30_000;
const INTERVIEW_DEADLINE_MS = 60_000;
const SYNTHESIS_DEADLINE_MS = 120_000;

export function getGeminiInterviewThinkingConfig(
  model: string,
  enableReasoning?: boolean
) {
  if (model.startsWith('gemini-3')) {
    return {
      thinkingConfig: {
        thinkingLevel: enableReasoning === true ? ThinkingLevel.HIGH : ThinkingLevel.LOW,
      },
    };
  }

  // Let Gemini choose its supported dynamic budget in Automatic mode. Gemini
  // 2.5 Pro cannot disable thinking, so Minimize uses its documented minimum.
  if (enableReasoning === undefined) return {};
  const minimumBudget = model.startsWith('gemini-2.5-pro') ? 128 : 0;
  return {
    thinkingConfig: {
      thinkingBudget: enableReasoning ? THINKING_BUDGET_25 : minimumBudget,
    },
  };
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;
  private model: string;

  constructor(model?: string, apiKey?: string | null) {
    // Only fall back to env var when apiKey is undefined (not explicitly provided)
    // In hosted mode, an empty string is passed to prevent env var fallback
    const key = apiKey !== undefined ? (apiKey || undefined) : process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('GEMINI_API_KEY is required');
    }
    this.ai = new GoogleGenAI({ apiKey: key });
    // Priority: constructor param > GEMINI_MODEL env > AI_MODEL env (legacy) > default
    this.model = model ||
      process.env.GEMINI_MODEL ||
      process.env.AI_MODEL ||
      DEFAULT_GEMINI_MODEL;
  }

  // For synthesis operations (Gemini 3.1 Pro) - use thinkingLevel instead of thinkingBudget
  private getSynthesisThinkingConfig(enableReasoning?: boolean) {
    const useReasoning = enableReasoning !== false;
    return {
      thinkingConfig: {
        // Gemini 3.1 Pro uses ThinkingLevel enum instead of thinkingBudget
        thinkingLevel: useReasoning ? ThinkingLevel.HIGH : ThinkingLevel.LOW
      }
    };
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string
  ): Promise<AIInterviewResponse> {
    const systemInstruction = buildInterviewSystemPrompt(
      studyConfig,
      participantProfile,
      questionProgress,
      currentContext
    );

    // Chat-level config. The per-request config below repeats these fields
    // because the SDK's per-request config does not inherit from chat config.
    const requestConfig = {
      systemInstruction,
      ...getGeminiInterviewThinkingConfig(this.model, studyConfig.enableReasoning),
      responseMimeType: 'application/json' as const,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          message: {
            type: Type.STRING,
            description: 'Your response to the participant'
          },
          questionAddressed: {
            type: Type.NUMBER,
            nullable: true,
            description: '0-based index of core question substantially addressed in this exchange, or null'
          },
          phaseTransition: {
            type: Type.STRING,
            nullable: true,
            enum: ['background', 'core-questions', 'exploration', 'feedback', 'wrap-up'],
            description: 'If interview should move to a new phase, specify it'
          },
          profileUpdates: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fieldId: { type: Type.STRING },
                value: { type: Type.STRING, nullable: true },
                status: {
                  type: Type.STRING,
                  enum: ['extracted', 'vague', 'refused']
                }
              },
              required: ['fieldId', 'status']
            },
            description: 'Profile fields extracted or updated from user response'
          },
          shouldConclude: {
            type: Type.BOOLEAN,
            description: 'True if interview should end (after wrap-up message)'
          }
        },
        required: ['message', 'profileUpdates', 'shouldConclude']
      }
    };

    const lastUserMessageIndex = history.findLastIndex(message => message.role === 'user');
    const priorHistory = lastUserMessageIndex >= 0
      ? history.slice(Math.max(0, lastUserMessageIndex - 10), lastUserMessageIndex)
      : history.slice(-10);
    const historyContents = priorHistory.map(h => ({
      role: h.role === 'ai' ? 'model' as const : 'user' as const,
      parts: [{ text: h.content }]
    }));

    let result;
    try {
      result = await withProviderDeadline(INTERVIEW_DEADLINE_MS, (signal) => {
        const chat = this.ai.chats.create({
          model: this.model,
          config: requestConfig,
          history: historyContents
        });

        const lastUserMessage = lastUserMessageIndex >= 0 ? history[lastUserMessageIndex] : undefined;
        return chat.sendMessage({
          message: lastUserMessage?.content || 'Please continue the interview.',
          config: {
            ...requestConfig,
            httpOptions: { timeout: INTERVIEW_DEADLINE_MS },
            abortSignal: signal
          }
        });
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) {
        throw error;
      }
      throw providerCallError('gemini', 'interview', error);
    }

    if (!result.text) {
      throw new ProviderFailure('invalid-response', 'Gemini interview returned no text');
    }

    try {
      return validateInterviewResponse(JSON.parse(cleanJSON(result.text)));
    } catch (error) {
      logProviderFailure('gemini', 'interview-parse', error);
      throw new ProviderFailure('invalid-response', 'Gemini interview returned unparseable or malformed JSON', error);
    }
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const prompt = buildGreetingPrompt(studyConfig);

    let response;
    try {
      response = await withProviderDeadline(GREETING_DEADLINE_MS, (signal) =>
        this.ai.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            httpOptions: { timeout: GREETING_DEADLINE_MS },
            abortSignal: signal
          }
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) {
        throw error;
      }
      throw providerCallError('gemini', 'greeting', error);
    }

    if (!response.text) {
      throw new ProviderFailure('invalid-response', 'Gemini greeting returned no text');
    }
    return response.text;
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null
  ): Promise<SynthesisResult> {
    const prompt = buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile);

    let response;
    try {
      response = await withProviderDeadline(SYNTHESIS_DEADLINE_MS, (signal) =>
        this.ai.models.generateContent({
          model: GEMINI_SYNTHESIS_MODEL,  // Use the configured higher-capability synthesis model
          contents: prompt,
          config: {
            ...this.getSynthesisThinkingConfig(studyConfig.enableReasoning),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                statedPreferences: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'What participant explicitly said they value/want'
                },
                revealedPreferences: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'What their behavior/emphasis revealed'
                },
                themes: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      theme: { type: Type.STRING },
                      evidence: { type: Type.STRING },
                      frequency: { type: Type.NUMBER }
                    }
                  }
                },
                contradictions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                keyInsights: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                bottomLine: {
                  type: Type.STRING,
                  description: 'One-sentence summary insight for the researcher'
                }
              },
              required: ['statedPreferences', 'revealedPreferences', 'themes', 'keyInsights', 'bottomLine']
            },
            httpOptions: { timeout: SYNTHESIS_DEADLINE_MS },
            abortSignal: signal
          }
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) {
        throw error;
      }
      throw providerCallError('gemini', 'synthesis', error);
    }

    if (!response.text) {
      throw new ProviderFailure('invalid-response', 'Gemini synthesis returned no text');
    }

    try {
      return validateSynthesisResult(JSON.parse(cleanJSON(response.text)));
    } catch (error) {
      logProviderFailure('gemini', 'synthesis-parse', error);
      throw new ProviderFailure('invalid-response', 'Gemini synthesis returned unparseable or malformed JSON', error);
    }
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number
  ) {
    const prompt = buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount);

    let response;
    try {
      response = await withProviderDeadline(SYNTHESIS_DEADLINE_MS, (signal) =>
        this.ai.models.generateContent({
          model: GEMINI_SYNTHESIS_MODEL,  // Use the configured higher-capability synthesis model
          contents: prompt,
          config: {
            ...this.getSynthesisThinkingConfig(studyConfig.enableReasoning),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                commonThemes: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      theme: { type: Type.STRING },
                      frequency: { type: Type.NUMBER },
                      representativeQuotes: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING }
                      }
                    }
                  }
                },
                divergentViews: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      topic: { type: Type.STRING },
                      viewA: { type: Type.STRING },
                      viewB: { type: Type.STRING }
                    }
                  }
                },
                keyFindings: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                researchImplications: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                bottomLine: {
                  type: Type.STRING,
                  description: 'One paragraph summarizing key takeaways'
                }
              },
              required: ['commonThemes', 'keyFindings', 'bottomLine']
            },
            httpOptions: { timeout: SYNTHESIS_DEADLINE_MS },
            abortSignal: signal
          }
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) {
        throw error;
      }
      throw providerCallError('gemini', 'aggregate-synthesis', error);
    }

    if (!response.text) {
      throw new ProviderFailure('invalid-response', 'Gemini aggregate synthesis returned no text');
    }

    try {
      return validateAggregateSynthesisPayload(JSON.parse(cleanJSON(response.text)));
    } catch (error) {
      logProviderFailure('gemini', 'aggregate-synthesis-parse', error);
      throw new ProviderFailure('invalid-response', 'Gemini aggregate synthesis returned unparseable or malformed JSON', error);
    }
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult
  ): Promise<{ name: string; researchQuestion: string; coreQuestions: string[] }> {
    const prompt = `You are helping design a follow-up research study.

PARENT STUDY: "${parentConfig.name}"
PARENT SUMMARY: ${synthesis.bottomLine}

KEY FINDINGS:
${synthesis.keyFindings.map((f, i) => `${i + 1}. ${f}`).join('\n')}

RESEARCH IMPLICATIONS:
${(synthesis.researchImplications || []).map((r, i) => `${i + 1}. ${r}`).join('\n') || 'None specified'}

DIVERGENT VIEWS:
${(synthesis.divergentViews || []).map(d => `- ${d.topic}: "${d.viewA}" vs "${d.viewB}"`).join('\n') || 'None identified'}

Generate a follow-up study that digs deeper into gaps or tensions found.
The follow-up should explore unanswered questions or interesting patterns from the original study.

Return a JSON object with:
- name: A concise study name (start with "Follow-up: ")
- researchQuestion: A specific, researchable question building on the findings
- coreQuestions: 3-5 interview questions to explore this further`;

    let response;
    try {
      response = await withProviderDeadline(SYNTHESIS_DEADLINE_MS, (signal) =>
        this.ai.models.generateContent({
          model: GEMINI_SYNTHESIS_MODEL,  // Use the configured higher-capability synthesis model
          contents: prompt,
          config: {
            ...this.getSynthesisThinkingConfig(parentConfig.enableReasoning),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                researchQuestion: { type: Type.STRING },
                coreQuestions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              },
              required: ['name', 'researchQuestion', 'coreQuestions']
            },
            httpOptions: { timeout: SYNTHESIS_DEADLINE_MS },
            abortSignal: signal
          }
        })
      );
    } catch (error) {
      if (error instanceof ProviderTimeoutError || error instanceof ProviderFailure) {
        throw error;
      }
      throw providerCallError('gemini', 'follow-up', error);
    }

    if (!response.text) {
      throw new ProviderFailure('invalid-response', 'Gemini follow-up study returned no text');
    }

    try {
      return validateFollowupStudy(JSON.parse(cleanJSON(response.text)));
    } catch (error) {
      logProviderFailure('gemini', 'follow-up-parse', error);
      throw new ProviderFailure('invalid-response', 'Gemini follow-up study returned unparseable or malformed JSON', error);
    }
  }
}
