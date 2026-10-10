// Portable, snapshot-only analysis views. Never reconstruct history from a live study.
import type { StoredInterview } from '@/types';
import { analysisStatus } from '@/lib/analysisState';
import { csvCell } from '@/lib/csv';
import { LANGUAGE_TAGS } from '@/lib/i18n/languages';
import { AI_SHARING_WARNING, escapeMarkdownInline } from './transcriptsMarkdown';

export const ANALYSIS_SCHEMA = 'openinterviewer.analysis.v1';
export const DEFINITION_UNAVAILABLE = '(definition unavailable)';
const iso = (timestamp: number) => new Date(timestamp).toISOString();

export function analysisProfile(interview: StoredInterview) {
  return {
    fields: (interview.participantProfile?.fields ?? []).map(field => ({
      fieldId: field.fieldId,
      label: interview.collectionConfig?.profileSchema.find(definition => definition.id === field.fieldId)?.label ?? DEFINITION_UNAVAILABLE,
      value: field.value,
      status: field.status,
    })),
    context: interview.participantProfile?.rawContext,
  };
}

export function analysisTurns(interview: StoredInterview) {
  return interview.transcript.flatMap((message, index) => message.role === 'system' ? [] : [{
    index: index + 1,
    messageId: message.id,
    role: message.role,
    speaker: message.role === 'user' ? 'Participant' as const : 'Interviewer' as const,
    timestamp: iso(message.timestamp),
    offsetSeconds: (message.timestamp - interview.createdAt) / 1000,
    text: message.content,
  }]);
}

export function analysisInterview(interview: StoredInterview) {
  const config = interview.collectionConfig;
  return {
    schema: ANALYSIS_SCHEMA,
    study: {
      id: interview.studyId, name: interview.studyName, revision: interview.studyRevision,
      researchQuestion: config?.researchQuestion, coreQuestions: config?.coreQuestions,
      topicAreas: config?.topicAreas, interviewLanguages: config?.interviewLanguages,
    },
    interview: {
      id: interview.id, status: interview.status,
      createdAt: iso(interview.createdAt), completedAt: iso(interview.completedAt),
      durationMinutes: (interview.completedAt - interview.createdAt) / 60_000,
      language: interview.interviewLanguage,
      languageTag: interview.interviewLanguage ? LANGUAGE_TAGS[interview.interviewLanguage] : undefined,
      voiceInput: config ? config.voiceInput ?? 'off' : undefined,
    },
    consent: {
      providerCommitment: interview.providerCommitment,
      conductedBy: { provider: interview.conductedByProvider, model: interview.conductedByModel },
      transport: interview.consentTransport ?? 'direct',
      consentHash: interview.consentHash,
      consentAcceptedAt: interview.consentAcceptedAt === undefined ? undefined : iso(interview.consentAcceptedAt),
    },
    analysis: {
      status: analysisStatus(interview), provider: interview.aiProvider, model: interview.aiModel,
      transport: interview.aiTransport ?? 'direct',
      bottomLine: interview.synthesis?.bottomLine, themes: interview.synthesis?.themes,
    },
    profile: analysisProfile(interview),
    turns: analysisTurns(interview),
  };
}

export function analysisJsonLine(interview: StoredInterview): string {
  return `${JSON.stringify(analysisInterview(interview))}\n`;
}

/** CSV record separators AND embedded text newlines are CRLF; JSONL retains exact text. */
export function analysisCsvRow(cells: readonly unknown[]): string {
  return cells.map(cell => {
    // A finite number cannot carry a formula; guarding it would turn -0.5 into text.
    if (typeof cell === 'number' && Number.isFinite(cell)) return `"${String(cell)}"`;
    return csvCell(cell === undefined || cell === null ? '' : String(cell).replace(/\r\n?|\n/g, '\r\n'));
  }).join(',') + '\r\n';
}
export const analysisCsvHeader = (cells: readonly string[]) => '\uFEFF' + analysisCsvRow(cells);

// The same descriptors generate the CSV and its data dictionary.
const INTERVIEW_COLUMNS = [
  ['schema', 'schema', 'Version identifier: openinterviewer.analysis.v1.'],
  ['study_id', 'study.id', 'Stored study ID.'],
  ['study_name', 'study.name', 'Study name recorded with this interview.'],
  ['study_revision', 'study.revision', 'Collection revision, not the current study revision.'],
  ['research_question', 'study.researchQuestion', 'Research question in collectionConfig.'],
  ['core_questions', 'study.coreQuestions', 'Collection core questions; JSON array in this CSV cell.'],
  ['topic_areas', 'study.topicAreas', 'Collection topic areas; JSON array in this CSV cell.'],
  ['interview_languages', 'study.interviewLanguages', 'Offered language codes in collectionConfig; JSON array in this CSV cell.'],
  ['interview_id', 'interview.id', 'Stored interview ID.'],
  ['status', 'interview.status', 'Stored interview status: in_progress or completed.'],
  ['created_at_utc', 'interview.createdAt', 'Start time, ISO 8601 UTC including milliseconds.'],
  ['completed_at_utc', 'interview.completedAt', 'Completion time, ISO 8601 UTC including milliseconds.'],
  ['duration_minutes', 'interview.durationMinutes', 'Elapsed minutes: (completedAt - createdAt) / 60000, not rounded.'],
  ['language', 'interview.language', 'Recorded participant language code; absent is not inferred as English.'],
  ['language_tag', 'interview.languageTag', 'BCP-47 tag from the shared language registry (zh becomes zh-Hans).'],
  ['voice_input', 'interview.voiceInput', 'Mode offered: off, browser or installation, not evidence that voice was used. A known snapshot with no setting means off.'],
  ['provider_commitment', 'consent.providerCommitment', 'Recorded promise: fixed or may-change; absent means not recorded.'],
  ['conducted_by_provider', 'consent.conductedBy.provider', 'Provider selected for the conversation, not synthesis.'],
  ['conducted_by_model', 'consent.conductedBy.model', 'Model requested for the conversation, not reported execution provenance.'],
  ['consent_transport', 'consent.transport', 'Transport disclosed at consent: cloudflare-gateway, or direct when absent in storage.'],
  ['consent_hash', 'consent.consentHash', 'Recorded hash of the accepted consent text.'],
  ['consent_accepted_at_utc', 'consent.consentAcceptedAt', 'Recorded consent acceptance time, ISO 8601 UTC.'],
  ['analysis_status', 'analysis.status', 'pending, running, complete or failed; legacy status follows the existing analysisStatus helper.'],
  ['analysis_provider', 'analysis.provider', 'Recorded synthesis provider (aiProvider).'],
  ['analysis_model', 'analysis.model', 'Recorded synthesis model (aiModel).'],
  ['analysis_transport', 'analysis.transport', 'Synthesis transport: cloudflare-gateway, or direct when absent in storage; not proof a synthesis ran.'],
  ['bottom_line', 'analysis.bottomLine', 'Saved synthesis bottom line; missing without synthesis.'],
  ['themes', 'analysis.themes', 'CSV: theme names joined with "; ". JSONL: original theme objects, including frequency and any evidence/evidenceRefs.'],
  ['profile_context', 'profile.context', 'Saved participantProfile.rawContext, not raw transcript text.'],
] as const;

export type ProfileColumn = { fieldId: string; label: string; createdAt: number; interviewId: string };
export type ProfileColumns = Map<string, ProfileColumn>;

/** Across studies/revisions, newest collection time wins; ties use descending interview ID. */
export function collectProfileColumns(columns: ProfileColumns, interview: StoredInterview): void {
  const definitions = new Map(interview.collectionConfig?.profileSchema.map(field => [field.id, field.label]));
  const fieldIds = new Set([...definitions.keys(), ...(interview.participantProfile?.fields ?? []).map(field => field.fieldId)]);
  for (const fieldId of fieldIds) {
    const previous = columns.get(fieldId);
    const candidate = { fieldId, label: definitions.get(fieldId) ?? DEFINITION_UNAVAILABLE, createdAt: interview.createdAt, interviewId: interview.id };
    if (!previous || candidate.createdAt > previous.createdAt
      || (candidate.createdAt === previous.createdAt && candidate.interviewId > previous.interviewId)) {
      columns.set(fieldId, candidate);
    }
  }
}
export function sortedProfileColumns(columns: ProfileColumns): ProfileColumn[] {
  return [...columns.values()].sort((a, b) => a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0);
}
/** Pack small dictionary fragments without retaining an export-wide header or README. */
export function* analysisTextChunks(parts: Iterable<string>): Generator<string> {
  let chunk = '';
  for (const part of parts) {
    if (chunk.length + part.length > 32 * 1024) { yield chunk; chunk = ''; }
    chunk += part;
  }
  if (chunk) yield chunk;
}
export function* analysisInterviewsHeaderParts(columns: ProfileColumn[]): Generator<string> {
  yield analysisCsvHeader(INTERVIEW_COLUMNS.map(column => column[0])).slice(0, -2);
  for (const column of columns) yield ',' + analysisCsvRow([`profile:${column.fieldId} (${column.label})`]).slice(0, -2);
  yield '\r\n';
}
export function analysisInterviewsHeader(columns: ProfileColumn[]): string {
  return [...analysisInterviewsHeaderParts(columns)].join('');
}
export function analysisInterviewsRow(interview: StoredInterview, columns: ProfileColumn[]): string {
  const record = analysisInterview(interview);
  const cells = INTERVIEW_COLUMNS.map(([, path]) => {
    let value: unknown = record;
    for (const key of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[key];
    if (path === 'analysis.themes') return record.analysis.themes?.map(theme => theme.theme).join('; ');
    return Array.isArray(value) ? JSON.stringify(value) : value;
  });
  const fields = new Map(record.profile.fields.map(field => [field.fieldId, field.value]));
  return analysisCsvRow([...cells, ...columns.map(column => fields.get(column.fieldId))]);
}

export const TURN_COLUMNS = ['study_id', 'interview_id', 'turn_index', 'message_id', 'role', 'speaker', 'timestamp_utc', 'offset_s', 'language', 'text'];
export function analysisTurnsCsv(interview: StoredInterview): string {
  return analysisCsvHeader(TURN_COLUMNS) + analysisTurns(interview).map(turn => analysisCsvRow([
    interview.studyId, interview.id, turn.index, turn.messageId, turn.role, turn.speaker,
    turn.timestamp, turn.offsetSeconds, interview.interviewLanguage, turn.text,
  ])).join('');
}
export const analysisTurnsName = (position: number) => `analysis/turns/${String(position + 1).padStart(3, '0')}.csv`;
export const PROFILE_COLUMNS = ['interview_id', 'study_revision', 'field_id', 'label_at_collection', 'value', 'status'];
export function analysisProfileRows(interview: StoredInterview): string {
  return analysisProfile(interview).fields.map(field => analysisCsvRow([
    interview.id, interview.studyRevision, field.fieldId, field.label, field.value, field.status,
  ])).join('');
}

export function analysisReadme(columns: ProfileColumn[]): string {
  return [...analysisReadmeParts(columns)].join('');
}
export function* analysisReadmeParts(columns: ProfileColumn[]): Generator<string> {
  yield `# Analysis files

${AI_SHARING_WARNING}

These views use each interview's own saved collectionConfig and consent/provider records, never today's study configuration. See consent in JSONL for what was recorded for each participant. Unknown optional values are omitted from JSONL and blank in CSV; explicit null profile values remain null in JSONL. Missing history is not reconstructed. All timestamps are ISO UTC.

## Files and encoding

- interviews.jsonl: one object per interview, schema ${ANALYSIS_SCHEMA}. UTF-8, no BOM, LF record endings. JSON escapes decode to the EXACT stored turn text, including original line endings.
- interviews.csv: one row per interview, followed by a column for every observed profile field ID across the export.
- turns/NNN.csv: one turn CSV per interview, numbered in the same export order as the top-level NNN records. Sharded instead of turns.csv to bound Worker memory. Each shard has its own header and BOM.
- profile_fields.csv: one row per saved profile field value, preserving the label at collection.
- README.md: this data dictionary and sharing guidance.

All CSVs are UTF-8 with BOM, CRLF record endings and quoted cells. Embedded text newlines are normalized to CRLF. Every text cell, including headers, passes the spreadsheet formula-injection guard; numbers are written as plain numbers. CSV text cells may start with an added apostrophe (') for that guard: use the JSONL for verbatim quotes, not CSV.

## interviews.csv columns and JSONL fields

${INTERVIEW_COLUMNS.map(([name, path, description]) => `- ${name} → ${path}: ${description}`).join('\n')}

Dynamic columns have the header profile:<fieldId> (<newest label>), ordered by field ID (code-unit order). One column per field ID observed in saved profile values or collectionConfig.profileSchema, even across studies: do not assume the same ID has the same meaning across studies. The newest interview by createdAt supplies the label from its own collectionConfig; ties use descending interview ID. Missing definitions use "${DEFINITION_UNAVAILABLE}" rather than a current or older label. Values are preserved regardless of extraction status; blank conflates absent, null and empty text in CSV. Use JSONL or profile_fields.csv for status and historical labels.

`;
  for (const column of columns) yield `- ${escapeMarkdownInline(`profile:${column.fieldId} (${column.label})`)}: saved value for field ID ${escapeMarkdownInline(column.fieldId)}.\n`;
  yield `

## JSONL nested structures

- study, interview, consent, analysis and profile: grouped fields defined above. consent.conductedBy groups the recorded conversation provider and model.
- profile.fields: saved profile values, each with fieldId (schema ID), label (definition in this interview's collectionConfig, or "${DEFINITION_UNAVAILABLE}"), value (string or null), status (pending, extracted, vague or refused). profile.context is rawContext.
- analysis.themes[]: theme (name), frequency (saved count), optional evidence (legacy free text), optional evidenceRefs (citation claims). Each ref has quote (claimed excerpt), turnIndex (1-based full transcript coordinate), and optional interviewId. These are claims, not verified interpretations.
- turns[]: index, messageId, role, speaker, timestamp, offsetSeconds and text, defined below. System messages are excluded, not renumbered.

## Turn CSV columns (JSONL turns field in parentheses)

- study_id: containing study.id.
- interview_id: containing interview.id.
- turn_index (index): 1-based position in the FULL stored transcript, matching analysis citation numbering (EvidenceRef.turnIndex). System messages are skipped without reusing their index, so gaps are intentional.
- message_id (messageId): stored message.id.
- role (role): stored user or ai.
- speaker (speaker): Participant for user; Interviewer for ai.
- timestamp_utc (timestamp): message.timestamp as ISO UTC.
- offset_s (offsetSeconds): (message.timestamp - interview.createdAt) / 1000, not rounded; may be negative.
- language: containing interview.language, blank if unrecorded.
- text (text): message.content; exact in JSONL, guarded and newline-normalized in CSV.

## profile_fields.csv columns

- interview_id: containing interview.id.
- study_revision: containing study.revision (collection revision).
- field_id: profile.fields[].fieldId.
- label_at_collection: profile.fields[].label from this interview's snapshot, not the newest label.
- value: profile.fields[].value; null becomes blank.
- status: profile.fields[].status, including non-extracted values.
`;
}
