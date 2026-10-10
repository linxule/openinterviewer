import { describe, expect, it } from 'vitest';
import {
  analysisCsvHeader, analysisCsvRow, analysisInterview, analysisInterviewsHeader, analysisInterviewsRow,
  analysisJsonLine, analysisProfileRows, analysisReadme, analysisTurnsCsv, analysisTurnsName,
  collectProfileColumns, DEFINITION_UNAVAILABLE, PROFILE_COLUMNS, sortedProfileColumns, type ProfileColumns,
} from '@/lib/export/analysisFiles';
import { AI_SHARING_WARNING, transcriptsMarkdownHeader } from '@/lib/export/transcriptsMarkdown';
import { interviewTranscriptMarkdown } from '@/lib/export/interviewExport';
import { resolveEvidenceRef } from '@/lib/evidence';
import { makeStoredInterview, makeStoredStudy, makeStudyConfig } from '../fixtures/models';
import { INTERVIEW_LANGUAGES, LANGUAGE_TAGS } from '@/lib/i18n/languages';

// Parse quoted multiline CSV, as an importing spreadsheet would (no formula evaluation).
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(cell); cell = ''; }
    else if (!quoted && ch === '\r' && text[i + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += ch;
  }
  return rows;
}

const base = Date.UTC(2026, 9, 10, 12);
function fixture() {
  return makeStoredInterview({
    id: 'iv-1', studyId: 'study-1', studyName: '研究', studyRevision: 3,
    createdAt: base, completedAt: base + 90_500, status: 'completed',
    collectionConfig: makeStudyConfig({ interviewLanguages: ['zh', 'en', 'fr'], voiceInput: 'installation' }),
    interviewLanguage: 'zh', providerCommitment: 'fixed', conductedByProvider: 'openai', conductedByModel: 'fixture-conversation',
    consentTransport: 'cloudflare-gateway', consentHash: 'a'.repeat(64), consentAcceptedAt: base - 1000,
    aiProvider: 'gemini', aiModel: 'fixture-synthesis', aiTransport: 'cloudflare-gateway',
    participantProfile: { id: 'p', fields: [
      { fieldId: 'role', value: '=SUM(1,2)\n研究 "角色"', status: 'extracted' },
      { fieldId: 'missing', value: null, status: 'refused' },
    ], rawContext: '@context', timestamp: base },
    transcript: [
      { id: 's', role: 'system', timestamp: base, content: 'Not an interview turn' },
      { id: 'a', role: 'ai', timestamp: base + 500, content: '你好，做什么？' },
      { id: 'u', role: 'user', timestamp: base + 1200, content: '=研究, "引文"\r\n第二行\n第三行\r尾行' },
    ],
    synthesis: { bottomLine: '+insight', themes: [{ theme: '主题一', frequency: 1 }, { theme: '主题二', frequency: 2, evidenceRefs: [{ quote: '研究', turnIndex: 3 }] }],
      statedPreferences: [], revealedPreferences: [], contradictions: [], keyInsights: [] },
  });
}

describe('analysis file builders', () => {
  it('projects only recorded collection and consent data, distinguishing conducting from analysis provenance', () => {
    const interview = fixture();
    const record = analysisInterview(interview);
    expect(record.study).toEqual({ id: 'study-1', name: '研究', revision: 3,
      researchQuestion: interview.collectionConfig!.researchQuestion, coreQuestions: interview.collectionConfig!.coreQuestions,
      topicAreas: interview.collectionConfig!.topicAreas, interviewLanguages: ['zh', 'en', 'fr'] });
    expect(record.interview).toEqual({ id: 'iv-1', status: 'completed', createdAt: '2026-10-10T12:00:00.000Z', completedAt: '2026-10-10T12:01:30.500Z', durationMinutes: 90.5 / 60, language: 'zh', languageTag: 'zh-Hans', voiceInput: 'installation' });
    expect(record.consent).toEqual({ providerCommitment: 'fixed', conductedBy: { provider: 'openai', model: 'fixture-conversation' }, transport: 'cloudflare-gateway', consentHash: 'a'.repeat(64), consentAcceptedAt: '2026-10-10T11:59:59.000Z' });
    expect(record.analysis).toEqual({ status: 'complete', provider: 'gemini', model: 'fixture-synthesis', transport: 'cloudflare-gateway', bottomLine: '+insight', themes: interview.synthesis!.themes });
    expect(record.profile.context).toBe('@context');
  });

  it('JSONL has LF and no BOM, preserving exact text including mixed embedded line endings and CJK', () => {
    const interview = fixture();
    const line = analysisJsonLine(interview);
    expect(line.charCodeAt(0)).not.toBe(0xfeff);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(line).not.toContain('\r');
    const parsed = JSON.parse(line);
    expect(parsed.schema).toBe('openinterviewer.analysis.v1');
    expect(parsed.turns[1].text).toBe(interview.transcript[2].content);
    expect(parsed.profile.fields[1].value).toBeNull();
  });

  it('CSV and JSONL preserve the full-transcript evidence/citation index across a system message', () => {
    const interview = fixture();
    interview.transcript[2].content = '研究 participants said this';
    const json = JSON.parse(analysisJsonLine(interview));
    const csv = parseCsv(analysisTurnsCsv(interview));
    expect(json.turns.map((turn: { index: number }) => turn.index)).toEqual([2, 3]);
    expect(csv.slice(1).map(row => Number(row[2]))).toEqual([2, 3]);
    const ref = { quote: interview.transcript[2].content, turnIndex: Number(csv[2][2]) };
    expect(resolveEvidenceRef(ref, interview.transcript)).toMatchObject({ status: 'verified', turnIndex: json.turns[1].index });
    expect(csv[2]).toEqual(['study-1', 'iv-1', '3', 'u', 'user', 'Participant', '2026-10-10T12:00:01.200Z', '1.2', 'zh', interview.transcript[2].content]);
    expect(analysisTurnsName(0)).toBe('analysis/turns/001.csv');
    expect(analysisTurnsName(499)).toBe('analysis/turns/500.csv');
  });

  it('guards every CSV cell including headers; quotes commas, quotes, CJK and CRLF with a UTF-8 BOM', () => {
    const cells = ['=calc', ' +calc', '-1', '@fn', '\tfoo', '\nbar', '研究,"引文"'];
    const csv = analysisCsvHeader(cells) + analysisCsvRow(cells);
    expect([...new TextEncoder().encode(csv).slice(0, 3)]).toEqual([239, 187, 191]);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(parsed[1]);
    expect(parsed[0]).toEqual(["'=calc", "' +calc", "'-1", "'@fn", "'\tfoo", "'\r\nbar", '研究,"引文"']);
    const turns = analysisTurnsCsv(fixture());
    expect(parseCsv(turns)[2][9]).toBe("'=研究, \"引文\"\r\n第二行\r\n第三行\r\n尾行");
  });

  it('uses newest labels for wide headers and historical labels in long rows, regardless of input order', () => {
    const newer = fixture();
    const older = fixture();
    older.id = 'old'; older.createdAt -= 1000; older.studyRevision = 2;
    older.collectionConfig!.profileSchema[0].label = '旧角色';
    older.participantProfile.fields[0].value = '以前';
    const columns: ProfileColumns = new Map();
    collectProfileColumns(columns, older); collectProfileColumns(columns, newer);
    const sorted = sortedProfileColumns(columns);
    const header = parseCsv(analysisInterviewsHeader(sorted))[0];
    expect(header.slice(-2)).toEqual([`profile:missing (${DEFINITION_UNAVAILABLE})`, 'profile:role (Current Role)']);
    const row = parseCsv(analysisInterviewsRow(newer, sorted))[0];
    expect(row[header.indexOf('themes')]).toBe('主题一; 主题二');
    expect(row[header.indexOf('core_questions')]).toBe(JSON.stringify(newer.collectionConfig!.coreQuestions));
    expect(row[header.indexOf('bottom_line')]).toBe("'+insight");
    expect(row.at(-1)).toBe("'=SUM(1,2)\r\n研究 \"角色\"");
    const long = parseCsv(analysisCsvHeader(PROFILE_COLUMNS) + analysisProfileRows(older) + analysisProfileRows(newer));
    expect(long[1]).toEqual(['old', '2', 'role', '旧角色', '以前', 'extracted']);
    expect(long[4]).toEqual(['iv-1', '3', 'missing', DEFINITION_UNAVAILABLE, '', 'refused']);
    const reverse: ProfileColumns = new Map();
    collectProfileColumns(reverse, newer); collectProfileColumns(reverse, older);
    expect(sortedProfileColumns(reverse)).toEqual(sorted);
    const tie = fixture(); tie.id = 'z'; tie.collectionConfig!.profileSchema[0].label = 'Tie winner';
    collectProfileColumns(columns, tie);
    expect(columns.get('role')!.label).toBe('Tie winner');
  });

  it('includes schema-only field IDs with blank wide values, without inventing long-form values', () => {
    const interview = fixture();
    interview.collectionConfig!.profileSchema.push({ id: 'not-answered', label: 'New unanswered question', required: false, extractionHint: '' });
    const columns: ProfileColumns = new Map();
    collectProfileColumns(columns, interview);
    const sorted = sortedProfileColumns(columns);
    expect(parseCsv(analysisInterviewsHeader(sorted))[0]).toContain('profile:not-answered (New unanswered question)');
    expect(parseCsv(analysisInterviewsRow(interview, sorted))[0].at(-2)).toBe('');
    expect(analysisProfileRows(interview)).not.toContain('not-answered');
  });

  it('never backfills absent snapshot, language, revision, consent or execution provenance', () => {
    const interview = makeStoredInterview({ createdAt: base, completedAt: base, participantProfile: fixture().participantProfile });
    const record = JSON.parse(analysisJsonLine(interview));
    expect(record.study).toEqual({ id: 'study-1', name: 'Study 1' });
    expect(record.interview).not.toHaveProperty('voiceInput');
    expect(record.interview).not.toHaveProperty('language');
    expect(record.consent).toEqual({ conductedBy: {}, transport: 'direct' });
    expect(record.analysis).toEqual({ status: 'pending', transport: 'direct' });
    expect(record.profile.fields.every((field: { label: string }) => field.label === DEFINITION_UNAVAILABLE)).toBe(true);
    interview.collectionConfig = makeStudyConfig();
    expect(analysisInterview(interview).interview.voiceInput).toBe('off');
    interview.collectionConfig.voiceInput = 'browser';
    expect(analysisInterview(interview).interview.voiceInput).toBe('browser');
  });

  it.each(INTERVIEW_LANGUAGES)('exports the recorded %s language and its shared BCP-47 tag', language => {
    const interview = fixture(); interview.interviewLanguage = language;
    expect(analysisInterview(interview).interview).toMatchObject({ language, languageTag: LANGUAGE_TAGS[language] });
    expect(parseCsv(analysisTurnsCsv(interview))[1][8]).toBe(language);
  });

  it('README reuses the exact Markdown sharing warning and defines all static CSV columns', () => {
    const readme = analysisReadme([]);
    expect(readme).toContain(AI_SHARING_WARNING);
    expect(transcriptsMarkdownHeader(makeStoredStudy(), 1, new Date(base))).toContain(AI_SHARING_WARNING);
    for (const header of [analysisInterviewsHeader([]), analysisCsvHeader(PROFILE_COLUMNS), analysisTurnsCsv(fixture())]) {
      for (const column of parseCsv(header)[0]) expect(readme).toContain(column);
    }
    expect(readme).toContain('apostrophe');
    expect(readme).toContain('FULL stored transcript');
    expect(readme).toContain('newest interview by createdAt');
  });

  it('ZIP Markdown dates do not use the server locale', () => {
    const text = interviewTranscriptMarkdown(fixture());
    expect(text).toContain('Date: 2026-10-10T12:00:00.000Z');
    expect(text).toContain('[2026-10-10T12:00:01.200Z] PARTICIPANT:');
  });
});
