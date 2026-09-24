// Synthetic provider payloads shared by the Cloudflare artifact server and its
// browser specs. Mirrors tests/e2e/workflow-fixture.ts so both lanes assert the
// same researcher-visible content.
export const ANSWER = 'I keep a short project note so I remember why I saved the document.';
export const GREETING = 'Tell me how you return to a saved research document.';
export const INSIGHT = 'Project notes preserve the reason for saving.';
export const UNSAID = 'I never write anything down about a document.';

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
