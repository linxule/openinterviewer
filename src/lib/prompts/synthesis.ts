/**
 * Interview Synthesis Prompt
 *
 * Analyzes completed interviews to extract patterns, themes, and insights.
 *
 * CUSTOMIZATION GUIDE:
 * - Modify analysis categories in the numbered list
 * - Add/remove what the AI looks for (themes, contradictions, etc.)
 * - Change the output structure expectations
 *
 * KEY VARIABLES:
 * - studyConfig: Research question and topic areas
 * - history: Full interview transcript
 * - behaviorData: Participant interaction patterns
 * - participantProfile: Collected demographic info
 */

import {
  StudyConfig,
  ParticipantProfile,
  InterviewMessage,
  BehaviorData,
  SynthesisResult
} from '@/types';

// Aggregate citation catalogue (Slice L). The aggregate model is shown no
// speech at all today; this catalogue is built from quotes a PREVIOUS
// per-interview synthesis already tied to a turn, so the aggregate model can
// only ever select a position in it, never compose a quote of its own.
export const MAX_AGGREGATE_QUOTE_REFS = 3;    // == aggregateSynthesisResponseSchema maxItems
const CATALOGUE_PASSES = 3;                   // at most 3 entries offered per interview
const CATALOGUE_CHAR_BUDGET = 40_000;         // rendered characters, all interviews combined

interface CatalogueEntry {
  turnIndex: number;
  quote: string;
}

function collectInterviewEntries(synthesis: SynthesisResult): CatalogueEntry[] {
  const seen = new Set<string>();
  const entries: CatalogueEntry[] = [];
  for (const theme of synthesis.themes) {
    for (const ref of theme.evidenceRefs ?? []) {
      const key = `${ref.turnIndex} ${ref.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ turnIndex: ref.turnIndex, quote: ref.quote });
    }
  }
  return entries;
}

function renderCatalogueLine(interviewIndex: number, entry: CatalogueEntry): string {
  return `[${interviewIndex}.${entry.turnIndex}] "${entry.quote}"`;
}

/**
 * Round-robin over interviews, not a prefix of them: pass k appends each
 * interview's k-th remaining entry, in interview order, so a study large
 * enough to exhaust the budget still gives every interview its first quote
 * before any interview gets its second (L4.1). Returns one rendered block
 * per interview, aligned to `syntheses`' index.
 */
function buildCatalogueBlocks(syntheses: SynthesisResult[]): string[] {
  const perInterview = syntheses.map(collectInterviewEntries);
  const rendered: string[][] = perInterview.map(() => []);
  let budgetUsed = 0;

  passes:
  for (let pass = 0; pass < CATALOGUE_PASSES; pass++) {
    for (let i = 0; i < perInterview.length; i++) {
      const entry = perInterview[i][pass];
      if (!entry) continue;
      const line = renderCatalogueLine(i + 1, entry);
      const cost = line.length + 1; // +1 for the newline joining this line to the block
      if (budgetUsed + cost > CATALOGUE_CHAR_BUDGET) break passes;
      rendered[i].push(line);
      budgetUsed += cost;
    }
  }

  return rendered.map((lines) => (
    lines.length > 0
      ? `Citable quotes:\n${lines.join('\n')}`
      : 'Citable quotes: none available for this interview.'
  ));
}

/**
 * Build the synthesis/analysis prompt
 *
 * This prompt instructs the AI to analyze the interview transcript
 * and extract meaningful patterns for researchers.
 */
export const buildSynthesisPrompt = (
  history: InterviewMessage[],
  studyConfig: StudyConfig,
  behaviorData: BehaviorData,
  participantProfile: ParticipantProfile | null
): string => {
  // Format transcript. Numbering runs over every element of `history`, 1-based,
  // regardless of role, because that is the array the researcher's `t. N`
  // coordinate and evidence references address.
  const interviewText = history
    .map((m, i) => `TURN ${i + 1} · ${m.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER'}: ${m.content}`)
    .join('\n\n');

  // Format profile data for synthesis
  const profileSummary = participantProfile?.fields
    .filter(f => f.status === 'extracted' && f.value)
    .map(f => {
      const field = studyConfig.profileSchema.find(s => s.id === f.fieldId);
      return `${field?.label || f.fieldId}: ${f.value}`;
    })
    .join('\n') || 'No structured profile data';

  return `Analyze this research interview for key patterns and insights.

STUDY:
- Research Question: ${studyConfig.researchQuestion}
- Topics Explored: ${studyConfig.topicAreas.join(', ')}

PARTICIPANT PROFILE:
${profileSummary}

Context: ${participantProfile?.rawContext || 'Not available'}

INTERVIEW TRANSCRIPT:
${interviewText}

BEHAVIORAL DATA:
- Interview phases: ${JSON.stringify(behaviorData.messagesPerTopic)}

Analyze for:
1. What they explicitly stated as important
2. What their behavior/emphasis revealed
3. Key themes, each supported by direct citations from the transcript
4. Any contradictions between stated and revealed preferences
5. Key insights for the researcher

CITING EVIDENCE:
For each theme, provide 1-3 citations in "evidenceRefs". Each citation has:
- "quote": an excerpt copied character-for-character from a single PARTICIPANT
  turn. Do not paraphrase, correct, translate, or tidy it. Do not join text
  from two turns into one quote. If you shorten the middle of a passage, mark
  the omission with an ellipsis (...); do not silently splice.
- "turnIndex": the number printed as TURN N beside that participant turn.
Quote only PARTICIPANT turns. If no single participant turn supports a theme,
prefer leaving that theme out to citing a turn that does not say it. An empty
"evidenceRefs" array is honest and acceptable; an inaccurate quote is not.`;
};

/**
 * Synthesis output schema description
 *
 * The AI should return:
 * - statedPreferences: What participant explicitly said they value
 * - revealedPreferences: What behavior/emphasis revealed
 * - themes: Key themes with evidence and frequency
 * - contradictions: Gaps between stated and revealed
 * - keyInsights: Actionable insights for researchers
 * - bottomLine: One-sentence summary
 */
export const synthesisOutputDescription = `
Expected output structure:
{
  "statedPreferences": ["What participant said they value/want"],
  "revealedPreferences": ["What their behavior/emphasis revealed"],
  "themes": [
    {
      "theme": "Theme name",
      "frequency": 3,
      "evidenceRefs": [
        { "quote": "Exact words from one participant turn", "turnIndex": 7 }
      ]
    }
  ],
  "contradictions": ["Any gaps between stated and revealed preferences"],
  "keyInsights": ["Actionable insights for the researcher"],
  "bottomLine": "One-sentence summary insight"
}
`;

/**
 * Aggregate Synthesis Prompt
 *
 * Analyzes multiple interview syntheses to find cross-participant patterns.
 *
 * KEY VARIABLES:
 * - studyConfig: Research question and topic areas
 * - syntheses: Array of individual interview synthesis results
 */
export const buildAggregateSynthesisPrompt = (
  studyConfig: StudyConfig,
  syntheses: SynthesisResult[],
  interviewCount: number
): string => {
  // Format individual syntheses for aggregate analysis
  const catalogueBlocks = buildCatalogueBlocks(syntheses);
  const synthesesText = syntheses.map((s, i) => `
--- Interview ${i + 1} ---
Key Themes: ${s.themes.map(t => t.theme).join(', ')}
Stated Preferences: ${s.statedPreferences.join('; ')}
Revealed Preferences: ${s.revealedPreferences.join('; ')}
Contradictions: ${s.contradictions.join('; ') || 'None identified'}
Key Insights: ${s.keyInsights.join('; ')}
Bottom Line: ${s.bottomLine}
${catalogueBlocks[i]}
`).join('\n');

  return `Analyze ${interviewCount} research interviews to identify cross-participant patterns.

STUDY:
- Research Question: ${studyConfig.researchQuestion}
- Topics Explored: ${studyConfig.topicAreas.join(', ')}

INDIVIDUAL INTERVIEW ANALYSES:
${synthesesText}

Your task is to identify:
1. COMMON THEMES - Patterns that appear across multiple interviews (note frequency)
2. DIVERGENT VIEWS - Where participants had notably different perspectives
3. KEY FINDINGS - The most important discoveries across all interviews
4. RESEARCH IMPLICATIONS - What these findings mean for the research question
5. BOTTOM LINE - A one-paragraph summary of insights from all ${interviewCount} interviews

Look for:
- Themes that recur across multiple participants
- Areas of consensus vs disagreement
- Surprising or unexpected patterns
- Connections between different themes
- Evidence that supports or challenges the research question

CITING EVIDENCE:
Every quote you attach to a common theme must be one of the CITABLE QUOTES
listed above. For each common theme, provide 0-3 citations in "quoteRefs".
Each citation has:
- "interviewIndex": the first number in the [i.t] tag of the entry you chose.
- "turnIndex": the second number in that tag.
- "quote": the text of that entry, copied character-for-character, without the
  surrounding quotation marks.
Do not write a quote of your own. Do not merge two entries into one. Do not
adjust wording, spelling, punctuation, or capitalization. If no listed quote
supports a theme, return an empty "quoteRefs" array — that is honest; an
invented quote is not.`;
};

/**
 * Aggregate Synthesis output schema description
 */
export const aggregateSynthesisOutputDescription = `
Expected output structure:
{
  "commonThemes": [
    {
      "theme": "Theme name",
      "frequency": 3,
      "quoteRefs": [
        { "interviewIndex": 1, "turnIndex": 7, "quote": "Exact text of a citable quote" }
      ]
    }
  ],
  "divergentViews": [
    {
      "topic": "Area of disagreement",
      "viewA": "One perspective",
      "viewB": "Contrasting perspective"
    }
  ],
  "keyFindings": ["Major discoveries that answer the research question"],
  "researchImplications": ["What these findings mean for the field/practice"],
  "bottomLine": "One paragraph summarizing the key takeaways from all interviews"
}
`;
