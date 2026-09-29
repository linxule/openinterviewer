// Synthetic provider payloads shared by the Cloudflare artifact server and its
// browser specs. Mirrors tests/e2e/workflow-fixture.ts so both lanes assert the
// same researcher-visible content.
export const ANSWER = 'I keep a short project note so I remember why I saved the document.';
export const GREETING = 'Tell me how you return to a saved research document.';
export const INSIGHT = 'Project notes preserve the reason for saving.';
export const UNSAID = 'I never write anything down about a document.';
export const EXPLORATION_TEXT = 'A provisional context-keeper archetype is supported, but these interviews do not establish three distinct archetypes.';
export const EXPLORATION = {
  answer: EXPLORATION_TEXT,
  findings: [{
    heading: 'Keeping the reason for saving',
    interpretation: 'The participant describes retaining context. This is an interpretation of a recorded behavior, not population prevalence.',
    supporting: [{ interviewIndex: 1, turnIndex: 2, quote: ANSWER }],
    challenging: [{ interviewIndex: 1, turnIndex: 2, quote: UNSAID }],
    uncertain: [{ interviewIndex: 1, turnIndex: 1, quote: GREETING }],
  }],
  limitations: ['The selected transcripts cannot support claims about participants whose profile values are unknown.'],
};

export const SYNTHESIS = {
  statedPreferences: ['A short project note'],
  revealedPreferences: ['Context before rereading'],
  themes: [{ theme: 'Remembering context', frequency: 1, evidenceRefs: [{ quote: ANSWER, turnIndex: 2 }] }],
  contradictions: [],
  keyInsights: [INSIGHT],
  bottomLine: INSIGHT,
};

export const AGGREGATE = {
  commonThemes: [{
    theme: 'Remembering context',
    frequency: 2,
    quoteRefs: [
      { interviewIndex: 1, turnIndex: 2, quote: ANSWER },
      { interviewIndex: 2, turnIndex: 2, quote: UNSAID },
    ],
  }],
  divergentViews: [],
  keyFindings: ['Both participants keep contextual notes.'],
  researchImplications: ['Investigate when notes are written.'],
  bottomLine: 'Context notes help both participants resume work.',
};
