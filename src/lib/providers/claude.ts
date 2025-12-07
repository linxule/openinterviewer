// Claude AI Provider Implementation
// Server-side only - uses API key from environment

import Anthropic from '@anthropic-ai/sdk';
import {
  AIProvider,
  buildInterviewSystemPrompt,
  cleanJSON,
  defaultInterviewResponse,
  defaultSynthesisResult,
  defaultAggregateSynthesisResult
} from '../ai';
import {
  buildGreetingPrompt,
  getDefaultGreeting,
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
  AggregateSynthesisResult
} from '@/types';

export class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for Claude provider');
    }
    this.client = new Anthropic({ apiKey });
    this.model = process.env.AI_MODEL || 'claude-sonnet-4-5';
  }

  async generateInterviewResponse(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    participantProfile: ParticipantProfile | null,
    questionProgress: QuestionProgress,
    currentContext: string
  ): Promise<AIInterviewResponse> {
    const systemPrompt = buildInterviewSystemPrompt(
      studyConfig,
      participantProfile,
      questionProgress,
      currentContext
    );

    // Define tool for structured response
    const interviewResponseTool: Anthropic.Tool = {
      name: 'interview_response',
      description: 'Generate a structured interview response',
      input_schema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Your response to the participant'
          },
          questionAddressed: {
            type: ['number', 'null'],
            description: '0-based index of core question substantially addressed in this exchange, or null'
          },
          phaseTransition: {
            type: ['string', 'null'],
            enum: ['background', 'core-questions', 'exploration', 'feedback', 'wrap-up', null],
            description: 'If interview should move to a new phase, specify it'
          },
          profileUpdates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fieldId: { type: 'string' },
                value: { type: ['string', 'null'] },
                status: {
                  type: 'string',
                  enum: ['extracted', 'vague', 'refused']
                }
              },
              required: ['fieldId', 'status']
            },
            description: 'Profile fields extracted or updated from user response'
          },
          shouldConclude: {
            type: 'boolean',
            description: 'True if interview should end (after wrap-up message)'
          }
        },
        required: ['message', 'profileUpdates', 'shouldConclude']
      }
    };

    // Convert history to Claude format
    const messages: Anthropic.MessageParam[] = history.slice(-10).map(h => ({
      role: h.role === 'ai' ? 'assistant' : 'user',
      content: h.content
    }));

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt + '\n\nYou MUST use the interview_response tool to provide your response.',
        tools: [interviewResponseTool],
        tool_choice: { type: 'tool', name: 'interview_response' },
        messages
      });

      // Extract tool use result
      const toolUse = response.content.find(block => block.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        const input = toolUse.input as Record<string, unknown>;
        return {
          message: (input.message as string) || "That's interesting. Could you tell me more?",
          questionAddressed: (input.questionAddressed as number | null) ?? null,
          phaseTransition: (input.phaseTransition as AIInterviewResponse['phaseTransition']) ?? null,
          profileUpdates: (input.profileUpdates as AIInterviewResponse['profileUpdates']) || [],
          shouldConclude: (input.shouldConclude as boolean) || false
        };
      }

      return defaultInterviewResponse;
    } catch (error) {
      console.error('Claude interview response error:', error);
      return defaultInterviewResponse;
    }
  }

  async getInterviewGreeting(studyConfig: StudyConfig): Promise<string> {
    const prompt = buildGreetingPrompt(studyConfig);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });

      const textBlock = response.content.find(block => block.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        return textBlock.text;
      }
      return getDefaultGreeting(studyConfig);
    } catch (error) {
      console.error('Claude greeting error:', error);
      return getDefaultGreeting(studyConfig);
    }
  }

  async synthesizeInterview(
    history: InterviewMessage[],
    studyConfig: StudyConfig,
    behaviorData: BehaviorData,
    participantProfile: ParticipantProfile | null
  ): Promise<SynthesisResult> {
    // Define tool for structured synthesis (Claude-specific)
    const synthesisTool: Anthropic.Tool = {
      name: 'synthesis_result',
      description: 'Generate a structured interview synthesis',
      input_schema: {
        type: 'object',
        properties: {
          statedPreferences: {
            type: 'array',
            items: { type: 'string' },
            description: 'What participant explicitly said they value/want'
          },
          revealedPreferences: {
            type: 'array',
            items: { type: 'string' },
            description: 'What their behavior/emphasis revealed'
          },
          themes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                theme: { type: 'string' },
                evidence: { type: 'string' },
                frequency: { type: 'number' }
              },
              required: ['theme', 'evidence', 'frequency']
            }
          },
          contradictions: {
            type: 'array',
            items: { type: 'string' }
          },
          keyInsights: {
            type: 'array',
            items: { type: 'string' }
          },
          bottomLine: {
            type: 'string',
            description: 'One-sentence summary insight for the researcher'
          }
        },
        required: ['statedPreferences', 'revealedPreferences', 'themes', 'keyInsights', 'bottomLine']
      }
    };

    const prompt = buildSynthesisPrompt(history, studyConfig, behaviorData, participantProfile) +
      '\n\nUse the synthesis_result tool to provide your analysis.';

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        tools: [synthesisTool],
        tool_choice: { type: 'tool', name: 'synthesis_result' },
        messages: [{ role: 'user', content: prompt }]
      });

      // Extract tool use result
      const toolUse = response.content.find(block => block.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        return toolUse.input as SynthesisResult;
      }

      return defaultSynthesisResult;
    } catch (error) {
      console.error('Claude synthesis error:', error);
      return defaultSynthesisResult;
    }
  }

  async synthesizeAggregate(
    studyConfig: StudyConfig,
    syntheses: SynthesisResult[],
    interviewCount: number
  ) {
    // Define tool for structured aggregate synthesis
    const aggregateTool: Anthropic.Tool = {
      name: 'aggregate_synthesis_result',
      description: 'Generate a structured aggregate synthesis across multiple interviews',
      input_schema: {
        type: 'object',
        properties: {
          commonThemes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                theme: { type: 'string' },
                frequency: { type: 'number' },
                representativeQuotes: {
                  type: 'array',
                  items: { type: 'string' }
                }
              },
              required: ['theme', 'frequency', 'representativeQuotes']
            },
            description: 'Patterns appearing across multiple interviews'
          },
          divergentViews: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                viewA: { type: 'string' },
                viewB: { type: 'string' }
              },
              required: ['topic', 'viewA', 'viewB']
            },
            description: 'Areas where participants had different perspectives'
          },
          keyFindings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Major discoveries that answer the research question'
          },
          researchImplications: {
            type: 'array',
            items: { type: 'string' },
            description: 'What these findings mean for the field/practice'
          },
          bottomLine: {
            type: 'string',
            description: 'One paragraph summarizing key takeaways from all interviews'
          }
        },
        required: ['commonThemes', 'keyFindings', 'bottomLine']
      }
    };

    const prompt = buildAggregateSynthesisPrompt(studyConfig, syntheses, interviewCount) +
      '\n\nUse the aggregate_synthesis_result tool to provide your analysis.';

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        tools: [aggregateTool],
        tool_choice: { type: 'tool', name: 'aggregate_synthesis_result' },
        messages: [{ role: 'user', content: prompt }]
      });

      // Extract tool use result
      const toolUse = response.content.find(block => block.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        return toolUse.input as typeof defaultAggregateSynthesisResult;
      }

      return defaultAggregateSynthesisResult;
    } catch (error) {
      console.error('Claude aggregate synthesis error:', error);
      return defaultAggregateSynthesisResult;
    }
  }

  async generateFollowupStudy(
    parentConfig: StudyConfig,
    synthesis: AggregateSynthesisResult
  ): Promise<{ name: string; researchQuestion: string; coreQuestions: string[] }> {
    // Define tool for structured follow-up generation
    const followupTool: Anthropic.Tool = {
      name: 'followup_study',
      description: 'Generate a follow-up research study based on synthesis findings',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A concise study name (should start with "Follow-up: ")'
          },
          researchQuestion: {
            type: 'string',
            description: 'A specific, researchable question building on the findings'
          },
          coreQuestions: {
            type: 'array',
            items: { type: 'string' },
            description: '3-5 interview questions to explore this further'
          }
        },
        required: ['name', 'researchQuestion', 'coreQuestions']
      }
    };

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

Use the followup_study tool to provide your response.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        tools: [followupTool],
        tool_choice: { type: 'tool', name: 'followup_study' },
        messages: [{ role: 'user', content: prompt }]
      });

      // Extract tool use result
      const toolUse = response.content.find(block => block.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        const input = toolUse.input as { name: string; researchQuestion: string; coreQuestions: string[] };
        return {
          name: input.name || `Follow-up: ${parentConfig.name}`,
          researchQuestion: input.researchQuestion || synthesis.keyFindings[0] || '',
          coreQuestions: input.coreQuestions || []
        };
      }

      // Fallback to deterministic generation
      return {
        name: `Follow-up: ${parentConfig.name}`,
        researchQuestion: `What deeper insights emerge from exploring: ${synthesis.keyFindings[0] || 'the findings'}?`,
        coreQuestions: synthesis.keyFindings.slice(0, 3).map(f =>
          `Can you tell me more about your experience with: ${f}?`
        )
      };
    } catch (error) {
      console.error('Claude follow-up generation error:', error);
      // Fallback to deterministic generation
      return {
        name: `Follow-up: ${parentConfig.name}`,
        researchQuestion: `What deeper insights emerge from exploring: ${synthesis.keyFindings[0] || 'the findings'}?`,
        coreQuestions: synthesis.keyFindings.slice(0, 3).map(f =>
          `Can you tell me more about your experience with: ${f}?`
        )
      };
    }
  }
}
