/**
 * Interview Greeting Prompt
 *
 * Generates the opening message that welcomes participants to the interview.
 *
 * CUSTOMIZATION GUIDE:
 * - Start with Interviewer Manner in setup; self-hosters can edit this file.
 * - Adjust the structure (e.g., add/remove mention of question count)
 * - Change how profile gathering is introduced
 *
 * KEY VARIABLES:
 * - studyConfig.name: Study title shown to participant
 * - studyConfig.researchQuestion: Main research focus
 * - studyConfig.coreQuestions: List of main questions
 * - studyConfig.profileSchema: Background fields to collect
 */

import { StudyConfig } from '@/types';
import { buildInterviewerMannerBlock } from './interview';

export const GREETING_QUESTION_CRAFT = 'Keep it brief and plain. Do not praise or evaluate. Ask one open question.';

export const GREETING_MANNER_PRECEDENCE = 'Where INTERVIEWER MANNER conflicts with the instructions above, follow INTERVIEWER MANNER, but still thank them and ask one opening question.';
export const GREETING_OPENING = 'Write a brief opening of one or two sentences';
export const GREETING_PROFILE = "Start gathering their profile naturally - don't make it feel like a form.";

/**
 * Build the greeting generation prompt
 *
 * This prompt instructs the AI to create a welcoming opening message
 * that naturally starts gathering participant background information.
 */
export const buildGreetingPrompt = (studyConfig: StudyConfig): string => {
  const profileFieldLabels = studyConfig.profileSchema
    .filter(f => f.required)
    .map(f => f.label.toLowerCase())
    .slice(0, 3);

  return `You are starting a research interview.

Study: ${studyConfig.name}
Research Question: ${studyConfig.researchQuestion}
Number of core questions: ${studyConfig.coreQuestions.length}
Profile info to gather first: ${profileFieldLabels.join(', ')}

${GREETING_OPENING} that:
1. Thanks them for participating
2. Mentions you'll have about ${studyConfig.coreQuestions.length} main questions to explore
3. Asks an opening background question that naturally gathers their ${profileFieldLabels[0] || 'background'} and context

${GREETING_QUESTION_CRAFT} ${GREETING_PROFILE}

${buildInterviewerMannerBlock(studyConfig, GREETING_MANNER_PRECEDENCE)}`;
};
