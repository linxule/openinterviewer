/**
 * OpenInterviewer AI Prompts
 *
 * This folder contains all AI prompts used by the interview system.
 * Start with Interviewer Manner in study setup: presets or your own instructions.
 * Self-hosters can then modify these files for deeper prompt customization.
 *
 * FILES:
 * - interview.ts: Main interviewer system prompt and behavior modes
 * - greeting.ts: Opening message generation
 * - synthesis.ts: Post-interview analysis prompt
 *
 * For customization help, see the comments at the top of each file.
 */

// Interview system prompt and helpers
export {
  buildInterviewSystemPrompt,
  getAIBehaviorInstruction,
  formatProfileFields
} from './interview';

// Greeting generation
export {
  buildGreetingPrompt
} from './greeting';

// Interview synthesis/analysis
export {
  buildSynthesisPrompt,
  synthesisOutputDescription,
  buildAggregateSynthesisPrompt,
  aggregateSynthesisOutputDescription
} from './synthesis';
