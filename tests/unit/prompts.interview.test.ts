import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildInterviewSystemPrompt,
  INTERVIEWER_MANNER_HEADER,
  INTERVIEWER_MANNER_PRECEDENCE,
  QUESTION_CRAFT,
} from '@/lib/prompts/interview';
import { buildGreetingPrompt, GREETING_QUESTION_CRAFT, GREETING_MANNER_PRECEDENCE, GREETING_OPENING, GREETING_PROFILE } from '@/lib/prompts/greeting';
import { buildSynthesisPrompt, buildAggregateSynthesisPrompt } from '@/lib/prompts/synthesis';
import { makeStudyConfig } from '../fixtures/models';
import type { QuestionProgress } from '@/types';

const progress: QuestionProgress = {
  currentPhase: 'background', questionsAsked: [], total: 1, isComplete: false,
};

describe('interview question craft and researcher manner', () => {
  it('keeps the exact default craft without a researcher block or precedence override', () => {
    const prompt = buildInterviewSystemPrompt(makeStudyConfig(), null, progress, '');
    expect(prompt).toContain(QUESTION_CRAFT);
    expect(prompt).not.toContain('INTERVIEWER MANNER (written by the researcher');
    expect(prompt).not.toContain(INTERVIEWER_MANNER_PRECEDENCE);
    expect(prompt).not.toContain('reflect back');
    expect(prompt).not.toContain('Bundle related');
    expect(prompt).toContain('QUESTION CRAFT:');
    expect(prompt).not.toContain('Keep responses concise (2-3 sentences typical)');
    expect(prompt).toContain('When a core question is substantially addressed, note its index');
    expect(prompt).toContain('Extract profile data from user responses when mentioned');
    expect(prompt).toContain('Signal shouldConclude=true only after feedback phase is complete');
  });

  it('injects verbatim instructions strictly between question craft and output contract', () => {
    const interviewerInstructions = '  Speak slowly.\nUse [their terms] exactly.  ';
    const prompt = buildInterviewSystemPrompt(makeStudyConfig({ interviewerInstructions }), null, progress, '');
    expect(prompt).toContain(`${INTERVIEWER_MANNER_HEADER}\n${interviewerInstructions}\n\n${INTERVIEWER_MANNER_PRECEDENCE}`);
    expect(prompt.indexOf(INTERVIEWER_MANNER_HEADER)).toBeGreaterThan(prompt.indexOf('QUESTION CRAFT:'));
    expect(prompt.indexOf(INTERVIEWER_MANNER_HEADER)).toBeLessThan(prompt.indexOf('OUTPUT CONTRACT:'));
    expect(prompt).toContain(INTERVIEWER_MANNER_PRECEDENCE);
    expect(INTERVIEWER_MANNER_PRECEDENCE).toContain('shouldConclude');
    expect(prompt).not.toContain('Thank them warmly');
    expect(prompt).toContain('3. EXPLORATION PHASE: After all core questions, ask: "Is there anything else about [topic] you\'d like to explore or share?"');
    expect(prompt).toContain('4. FEEDBACK PHASE: Ask: "As a final question - do you have any feedback for the researchers about this study or interview experience?"');
  });

  it.each([undefined, 'Use a courteous register.\nNo small talk.'])('greeting includes manner iff set (%s)', (interviewerInstructions) => {
    const prompt = buildGreetingPrompt(makeStudyConfig({ interviewerInstructions }));
    expect(prompt).toContain(GREETING_QUESTION_CRAFT);
    expect(prompt).not.toContain('conversational and inviting');
    expect(prompt).not.toMatch(/warm/i);
    expect(prompt).toContain(GREETING_PROFILE);
    expect(prompt).toContain(GREETING_OPENING);
    if (interviewerInstructions === undefined) {
      expect(prompt).not.toContain(GREETING_MANNER_PRECEDENCE);
      expect(prompt).not.toContain('INTERVIEWER MANNER (written by the researcher');
    } else {
      expect(prompt).toContain(`${INTERVIEWER_MANNER_HEADER}\n${interviewerInstructions}`);
      expect(prompt.indexOf(INTERVIEWER_MANNER_HEADER)).toBeGreaterThan(prompt.indexOf('Profile info to gather first:'));
      expect(prompt).toContain(GREETING_MANNER_PRECEDENCE);
      expect(prompt.indexOf(GREETING_MANNER_PRECEDENCE)).toBeGreaterThan(prompt.indexOf(GREETING_OPENING));
    }
  });
});

it('keeps synthesis independent of researcher manner', () => {
  const prompt = buildSynthesisPrompt([], makeStudyConfig({ interviewerInstructions: 'INTERVIEWER MANNER sentinel' }),
    { timePerTopic: {}, messagesPerTopic: {}, topicsExplored: [], contradictions: [] }, null);
  expect(prompt).not.toContain('INTERVIEWER MANNER');
  expect(buildAggregateSynthesisPrompt(makeStudyConfig({ interviewerInstructions: 'INTERVIEWER MANNER sentinel' }), [], 0)).not.toContain('INTERVIEWER MANNER');
});

describe('README question craft', () => {
  it('quotes the QUESTION_CRAFT constant verbatim so a methods appendix cannot drift', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain(QUESTION_CRAFT);
  });
});
