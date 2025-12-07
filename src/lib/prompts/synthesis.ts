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
  // Format transcript
  const interviewText = history
    .map(m => `${m.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER'}: ${m.content}`)
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
3. Key themes with evidence
4. Any contradictions between stated and revealed preferences
5. Key insights for the researcher`;
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
    { "theme": "Theme name", "evidence": "Supporting quote/behavior", "frequency": 3 }
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
  const synthesesText = syntheses.map((s, i) => `
--- Interview ${i + 1} ---
Key Themes: ${s.themes.map(t => t.theme).join(', ')}
Stated Preferences: ${s.statedPreferences.join('; ')}
Revealed Preferences: ${s.revealedPreferences.join('; ')}
Contradictions: ${s.contradictions.join('; ') || 'None identified'}
Key Insights: ${s.keyInsights.join('; ')}
Bottom Line: ${s.bottomLine}
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
- Evidence that supports or challenges the research question`;
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
      "representativeQuotes": ["Example evidence from different interviews"]
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
