// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  validateAggregateSynthesisPayload,
  validateFollowupStudy,
  validateInterviewResponse,
  validateSynthesisResult,
} from '@/lib/providerValidation';

const validInterviewResponse = {
  message: 'Tell me about your current role.',
  questionAddressed: 2,
  phaseTransition: 'exploration',
  profileUpdates: [{ fieldId: 'role', value: 'Engineer', status: 'extracted' }],
  shouldConclude: false,
};

const validSynthesisResult = {
  statedPreferences: ['Speed'],
  revealedPreferences: ['Efficiency'],
  themes: [
    { theme: 'Speed', evidence: 'Mentioned speed three times', frequency: 3 },
    {
      theme: 'Onboarding friction',
      frequency: 2,
      evidenceRefs: [
        { quote: 'I started the flow and immediately got stuck.', turnIndex: 2 },
        { quote: 'the settings page confused me', turnIndex: 4, interviewId: 'interview-abc123' },
      ],
    },
  ],
  contradictions: ['Speed vs thoroughness'],
  keyInsights: ['Participants value speed most'],
  bottomLine: 'Participants consistently prioritize speed over thoroughness.',
};

const validAggregatePayload = {
  commonThemes: [
    { theme: 'Speed', frequency: 4, quoteRefs: [{ interviewIndex: 1, turnIndex: 3, quote: 'Speed matters' }] },
  ],
  divergentViews: [{ topic: 'Remote work', viewA: 'Prefer office', viewB: 'Prefer home' }],
  keyFindings: ['Speed is the dominant value'],
  researchImplications: ['Study deeper tradeoffs'],
  bottomLine: 'Across interviews, speed consistently outranks thoroughness.',
};

const validFollowupStudy = {
  name: 'Follow-up: Speed vs thoroughness',
  researchQuestion: 'When does speed beat thoroughness?',
  coreQuestions: ['When is speed most important?', 'What breaks when you rush?'],
};

// Mutation fixtures are intentionally untyped (malformed inputs).
const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value));

describe('validateInterviewResponse', () => {
  it('accepts a valid response and returns it unchanged', () => {
    expect(validateInterviewResponse(validInterviewResponse)).toEqual(validInterviewResponse);
  });

  it('normalizes null-able fields and profile update values to null', () => {
    const input = clone(validInterviewResponse);
    input.questionAddressed = null;
    input.phaseTransition = null;
    input.profileUpdates[0] = { fieldId: 'role', value: null, status: 'vague' };
    expect(validateInterviewResponse(input)).toEqual({
      message: 'Tell me about your current role.',
      questionAddressed: null,
      phaseTransition: null,
      profileUpdates: [{ fieldId: 'role', value: null, status: 'vague' }],
      shouldConclude: false,
    });
  });

  it('rejects profile update entries without an explicit value', () => {
    const input = clone(validInterviewResponse);
    input.profileUpdates[0] = { fieldId: 'role', status: 'vague' };
    expect(() => validateInterviewResponse(input)).toThrow(/profileUpdates\[0\].value/);
  });

  it('requires questionAddressed and phaseTransition to be present', () => {
    const input = clone(validInterviewResponse);
    delete input.questionAddressed;
    expect(() => validateInterviewResponse(input)).toThrow(/questionAddressed/);
    const withPhase = clone(validInterviewResponse);
    delete withPhase.phaseTransition;
    expect(() => validateInterviewResponse(withPhase)).toThrow(/phaseTransition/);
  });

  it('rejects non-object roots', () => {
    for (const bad of [null, 'text', 42, ['message']]) {
      expect(() => validateInterviewResponse(bad)).toThrow();
    }
  });

  it('rejects missing or empty message instead of substituting canned speech', () => {
    for (const bad of [undefined, '', '   ']) {
      const input = clone(validInterviewResponse);
      input.message = bad;
      expect(() => validateInterviewResponse(input)).toThrow(/message/);
    }
  });

  it('rejects non-boolean shouldConclude instead of defaulting to false', () => {
    for (const bad of [undefined, 'true', 1]) {
      const input = clone(validInterviewResponse);
      input.shouldConclude = bad;
      expect(() => validateInterviewResponse(input)).toThrow(/shouldConclude/);
    }
  });

  it('rejects malformed questionAddressed values', () => {
    for (const bad of ['2', -1, 1.5, { index: 2 }]) {
      const input = clone(validInterviewResponse);
      input.questionAddressed = bad;
      expect(() => validateInterviewResponse(input)).toThrow(/questionAddressed/);
    }
  });

  it('rejects unknown phaseTransition values', () => {
    for (const bad of ['not-a-phase', 3]) {
      const input = clone(validInterviewResponse);
      input.phaseTransition = bad;
      expect(() => validateInterviewResponse(input)).toThrow(/phaseTransition/);
    }
  });

  it('rejects malformed profileUpdates entries', () => {
    const input = clone(validInterviewResponse);
    input.profileUpdates = [{ fieldId: '', value: 'x', status: 'extracted' }];
    expect(() => validateInterviewResponse(input)).toThrow(/fieldId/);

    input.profileUpdates = [{ fieldId: 'role', value: 'x', status: 'unknown' }];
    expect(() => validateInterviewResponse(input)).toThrow(/status/);

    input.profileUpdates = [{ fieldId: 'role', value: 7, status: 'extracted' }];
    expect(() => validateInterviewResponse(input)).toThrow(/value/);

    input.profileUpdates = [{ value: 'x', status: 'extracted' }];
    expect(() => validateInterviewResponse(input)).toThrow(/fieldId/);

    input.profileUpdates = 'not-an-array';
    expect(() => validateInterviewResponse(input)).toThrow(/profileUpdates/);
  });

  it('rejects oversized provider-controlled interview output', () => {
    const message = clone(validInterviewResponse);
    message.message = 'x'.repeat(20_001);
    expect(() => validateInterviewResponse(message)).toThrow(/message/);

    const updates = clone(validInterviewResponse);
    updates.profileUpdates = Array.from({ length: 51 }, () => ({
      fieldId: 'role', value: 'Engineer', status: 'extracted',
    }));
    expect(() => validateInterviewResponse(updates)).toThrow(/profileUpdates/);
  });
});

describe('validateSynthesisResult', () => {
  it('accepts a valid synthesis and returns it unchanged', () => {
    expect(validateSynthesisResult(validSynthesisResult)).toEqual(validSynthesisResult);
  });

  it('rejects missing or malformed preference arrays', () => {
    const input = clone(validSynthesisResult);
    delete input.statedPreferences;
    expect(() => validateSynthesisResult(input)).toThrow(/statedPreferences/);

    input.statedPreferences = ['ok', 42];
    expect(() => validateSynthesisResult(input)).toThrow(/statedPreferences/);

    input.statedPreferences = ['ok'];
    input.revealedPreferences = 'prefer-efficiency';
    expect(() => validateSynthesisResult(input)).toThrow(/revealedPreferences/);
  });

  it('rejects malformed themes including nested shape and frequency', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{ theme: 'Speed', frequency: 3 }]; // missing evidence
    expect(() => validateSynthesisResult(input)).toThrow(/evidence/);

    input.themes = [{ theme: '', evidence: 'x', frequency: 3 }];
    expect(() => validateSynthesisResult(input)).toThrow(/themes\[0\]\.theme/);

    input.themes = [{ theme: 'Speed', evidence: 'x', frequency: '3' }];
    expect(() => validateSynthesisResult(input)).toThrow(/frequency/);

    input.themes = [{ theme: 'Speed', evidence: 'x', frequency: NaN }];
    expect(() => validateSynthesisResult(input)).toThrow(/frequency/);

    input.themes = [{ theme: 'Speed', evidence: 'x', frequency: -1 }];
    expect(() => validateSynthesisResult(input)).toThrow(/frequency/);

    input.themes = 'themes';
    expect(() => validateSynthesisResult(input)).toThrow(/themes/);
  });

  it('rejects a theme carrying both evidence and evidenceRefs', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{
      theme: 'Speed',
      frequency: 3,
      evidence: 'Mentioned speed three times',
      evidenceRefs: [{ quote: 'Speed matters a lot to me', turnIndex: 1 }],
    }];
    expect(() => validateSynthesisResult(input)).toThrow(/themes\[0\]/);
  });

  it('rejects a theme carrying neither evidence nor evidenceRefs', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{ theme: 'Speed', frequency: 3 }];
    expect(() => validateSynthesisResult(input)).toThrow(/themes\[0\]/);
  });

  it('rejects a turnIndex of 0', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{
      theme: 'Speed',
      frequency: 3,
      evidenceRefs: [{ quote: 'Speed matters a lot to me', turnIndex: 0 }],
    }];
    expect(() => validateSynthesisResult(input)).toThrow(/turnIndex/);
  });

  it('rejects a string turnIndex', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{
      theme: 'Speed',
      frequency: 3,
      evidenceRefs: [{ quote: 'Speed matters a lot to me', turnIndex: '3' }],
    }];
    expect(() => validateSynthesisResult(input)).toThrow(/turnIndex/);
  });

  it('rejects a theme with four evidence refs', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{
      theme: 'Speed',
      frequency: 3,
      evidenceRefs: [
        { quote: 'Speed matters a lot to me', turnIndex: 1 },
        { quote: 'Speed matters a lot to me', turnIndex: 2 },
        { quote: 'Speed matters a lot to me', turnIndex: 3 },
        { quote: 'Speed matters a lot to me', turnIndex: 4 },
      ],
    }];
    expect(() => validateSynthesisResult(input)).toThrow(/evidenceRefs/);
  });

  it('rejects an interviewId containing a slash', () => {
    const input = clone(validSynthesisResult);
    input.themes = [{
      theme: 'Speed',
      frequency: 3,
      evidenceRefs: [{ quote: 'Speed matters a lot to me', turnIndex: 1, interviewId: 'interview/abc' }],
    }];
    expect(() => validateSynthesisResult(input)).toThrow(/interviewId/);
  });

  it('rejects missing or empty bottomLine instead of defaulting it', () => {
    for (const bad of [undefined, '', '  ']) {
      const input = clone(validSynthesisResult);
      input.bottomLine = bad;
      expect(() => validateSynthesisResult(input)).toThrow(/bottomLine/);
    }
  });

  it('rejects malformed contradictions and keyInsights', () => {
    const input = clone(validSynthesisResult);
    input.contradictions = ['ok', { text: 'nested' }];
    expect(() => validateSynthesisResult(input)).toThrow(/contradictions/);

    input.contradictions = ['ok'];
    input.keyInsights = [];
    expect(() => validateSynthesisResult(input)).not.toThrow(); // empty arrays are structurally valid

    input.keyInsights = [42];
    expect(() => validateSynthesisResult(input)).toThrow(/keyInsights/);
  });

  it('rejects oversized synthesis collections and strings', () => {
    const input = clone(validSynthesisResult);
    input.keyInsights = Array.from({ length: 101 }, () => 'insight');
    expect(() => validateSynthesisResult(input)).toThrow(/keyInsights/);

    input.keyInsights = ['x'.repeat(20_001)];
    expect(() => validateSynthesisResult(input)).toThrow(/keyInsights/);
  });
});

describe('validateAggregateSynthesisPayload', () => {
  it('accepts a valid payload and returns it unchanged', () => {
    expect(validateAggregateSynthesisPayload(validAggregatePayload)).toEqual(validAggregatePayload);
  });

  it('requires divergentViews and researchImplications to be present', () => {
    const input = clone(validAggregatePayload);
    delete input.divergentViews;
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/divergentViews/);
    const withoutImplications = clone(validAggregatePayload);
    delete withoutImplications.researchImplications;
    expect(() => validateAggregateSynthesisPayload(withoutImplications)).toThrow(/researchImplications/);
  });

  it('rejects malformed commonThemes including nested quoteRefs', () => {
    const input = clone(validAggregatePayload);
    input.commonThemes = [{ theme: 'Speed', frequency: 4 }]; // missing quoteRefs
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/quoteRefs/);

    input.commonThemes = [{ theme: 'Speed', frequency: 4, quoteRefs: [{ interviewIndex: 1, turnIndex: 3 }] }]; // no quote
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/quote/);

    input.commonThemes = [{ theme: 'Speed', frequency: 4, quoteRefs: [{ interviewIndex: 0, turnIndex: 3, quote: 'x' }] }];
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/interviewIndex/);

    input.commonThemes = [{
      theme: 'Speed', frequency: 4,
      quoteRefs: [
        { interviewIndex: 1, turnIndex: 1, quote: 'a' },
        { interviewIndex: 1, turnIndex: 2, quote: 'b' },
        { interviewIndex: 1, turnIndex: 3, quote: 'c' },
        { interviewIndex: 1, turnIndex: 4, quote: 'd' },
      ],
    }];
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/quoteRefs/);

    input.commonThemes = [{
      theme: 'Speed', frequency: 4,
      representativeQuotes: ['"Speed matters"'],
      quoteRefs: [{ interviewIndex: 1, turnIndex: 3, quote: 'Speed matters' }],
    }];
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/representativeQuotes/);

    input.commonThemes = [{ theme: 'Speed', frequency: '4', quoteRefs: [] }];
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/frequency/);

    input.commonThemes = 'none';
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/commonThemes/);
  });

  it('rejects malformed divergentViews when present', () => {
    const input = clone(validAggregatePayload);
    input.divergentViews = [{ topic: 'Remote work', viewA: 'Office' }]; // missing viewB
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/viewB/);

    input.divergentViews = 'views';
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/divergentViews/);
  });

  it('rejects malformed keyFindings, researchImplications, and bottomLine', () => {
    const input = clone(validAggregatePayload);
    input.keyFindings = ['ok', 42];
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/keyFindings/);

    input.keyFindings = ['ok'];
    input.researchImplications = 'implications';
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/researchImplications/);

    input.researchImplications = [];
    input.bottomLine = '';
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/bottomLine/);
  });

  it('rejects oversized aggregate collections', () => {
    const input = clone(validAggregatePayload);
    input.commonThemes = Array.from({ length: 101 }, () => ({
      theme: 'Theme', frequency: 1, quoteRefs: [],
    }));
    expect(() => validateAggregateSynthesisPayload(input)).toThrow(/commonThemes/);
  });
});

describe('validateFollowupStudy', () => {
  it('accepts a valid follow-up study and returns it unchanged', () => {
    expect(validateFollowupStudy(validFollowupStudy)).toEqual(validFollowupStudy);
  });

  it('rejects missing or empty name instead of substituting the parent name', () => {
    for (const bad of [undefined, '', '   ']) {
      const input = clone(validFollowupStudy);
      input.name = bad;
      expect(() => validateFollowupStudy(input)).toThrow(/name/);
    }
  });

  it('rejects missing or empty researchQuestion instead of substituting a finding', () => {
    for (const bad of [undefined, '']) {
      const input = clone(validFollowupStudy);
      input.researchQuestion = bad;
      expect(() => validateFollowupStudy(input)).toThrow(/researchQuestion/);
    }
  });

  it('rejects missing, empty, or malformed coreQuestions', () => {
    for (const bad of [undefined, [], ['ok', 42]]) {
      const input = clone(validFollowupStudy);
      input.coreQuestions = bad;
      expect(() => validateFollowupStudy(input)).toThrow(/coreQuestions/);
    }
  });
});
