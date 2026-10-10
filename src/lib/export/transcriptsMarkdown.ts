// One Markdown file holding a study's transcripts, for reading or for handing
// to another tool. Both targets build it from these functions: Node joins the
// parts in memory and Cloudflare streams them page by page
// (createTranscriptsMarkdownStream), so the two files cannot drift apart.
//
// Participant and interviewer text is written only as `> `-prefixed lines
// under headings this module generates, so no transcript content can start a
// heading, a speaker line or the closing marker. The closing marker proves
// the download is complete (storageService.exportStudyTranscriptsChecked).

import type { StoredInterview, StoredStudy, StudyConfig } from '@/types';
import { PROVIDER_MODELS, PROVIDER_OPTIONS } from '@/lib/providerRegistry';
import { LANGUAGE_ENGLISH_NAMES, LANGUAGE_NATIVE_NAMES } from '@/lib/i18n/languages';

export const AI_SHARING_WARNING = [
    '> **Before sharing this file with an AI tool:** each interview below records what its',
    '> participant was told about the AI that would handle their responses. Where a participant',
    '> was told the study uses only one provider and model, sending this file to a different AI',
    '> service may break that promise.',
].join('\n');

export const TRANSCRIPTS_MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

const COMPLETE_MARKER_PREFIX = '<!-- openinterviewer-export complete: ';

export function transcriptsCompleteMarker(count: number): string {
  return `${COMPLETE_MARKER_PREFIX}${count} interview${count === 1 ? '' : 's'} -->`;
}

/** True when `text` ends with a complete-export marker on its own line. */
export function hasTranscriptsCompleteMarker(text: string): boolean {
  const lastLine = text.trimEnd().split('\n').pop() ?? '';
  return /^<!-- openinterviewer-export complete: \d+ interviews? -->$/.test(lastLine);
}

/** One line of inline text: no line breaks, Markdown and HTML syntax escaped. */
export function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\\`*_[\]<>#|~]/g, (character) => `\\${character}`)
    .trim();
}

/** Free text as a blockquote; every line, including blank ones, starts with `>`. */
export function quoteBlock(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

function isoUtc(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown';
}

function providerName(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

function modelName(provider: string | undefined, model: string | undefined): string | undefined {
  if (!model) return undefined;
  const models = provider && provider in PROVIDER_MODELS
    ? PROVIDER_MODELS[provider as keyof typeof PROVIDER_MODELS]
    : [];
  return models.find((entry) => entry.id === model)?.label ?? model;
}

/** What the participant was told about the AI, from the record's own snapshot. */
export function participantTermsLine(interview: StoredInterview): string {
  const conducted = interview.conductedByProvider && interview.conductedByModel
    ? `${modelName(interview.conductedByProvider, interview.conductedByModel)} (${providerName(interview.conductedByProvider)})`
    : 'not recorded';
  const commitment = interview.providerCommitment === 'fixed'
    ? 'told the study would use only this provider and model'
    : interview.providerCommitment === 'may-change'
    ? 'told the researcher may use a different AI provider or model'
    : 'no provider commitment recorded';
  const transport = interview.consentTransport === 'cloudflare-gateway' ? 'via Cloudflare AI Gateway' : 'direct';
  return escapeMarkdownInline(`AI interviewer: ${conducted}, ${transport}; ${commitment}.`);
}

/** The language the participant chose, for interviews of a study that offered languages; else null. */
export function interviewLanguageLine(interview: StoredInterview): string | null {
  const language = interview.interviewLanguage;
  if (!language || !Object.hasOwn(LANGUAGE_ENGLISH_NAMES, language)) return null;
  const english = LANGUAGE_ENGLISH_NAMES[language];
  const native = LANGUAGE_NATIVE_NAMES[language];
  return `Interview language: ${english}${native === english ? '' : ` (${native})`}`;
}

/** Whether voice input was offered at the revision this interview ran under (not whether it was used). */
export function voiceInputLine(interview: StoredInterview): string | null {
  switch (interview.collectionConfig?.voiceInput) {
    case 'installation': return 'Voice input offered: speech turned into text by Cloudflare Workers AI; the participant could edit the text before sending.';
    case 'browser': return 'Voice input offered: speech turned into text by the participant\'s browser speech service; the participant could edit the text before sending.';
    case 'device': return 'Voice input offered: the browser turns speech into text on the participant’s computer and says the recording stays there; the study receives only the text the participant sends. The browser may first download a speech pack (about 60 MB); the participant could edit the text before sending.';
    default: return null;
  }
}

export function transcriptsMarkdownHeader(study: StoredStudy, count: number, exportedAt: Date): string {
  const config: StudyConfig = study.config;
  const lines = [
    `# ${escapeMarkdownInline(config.name || 'Untitled study')}: interview transcripts`,
    '',
    `- Research question: ${escapeMarkdownInline(config.researchQuestion || 'not set')}`,
    `- Study ID: ${escapeMarkdownInline(study.id)}`,
    `- Exported: ${isoUtc(exportedAt.getTime())}`,
    `- Interviews: ${count}`,
    '',
    AI_SHARING_WARNING,
    '',
    'Transcript text is quoted exactly as saved. Times are UTC.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** `position` is zero-based in export order. */
export function transcriptsMarkdownInterview(interview: StoredInterview, position: number): string {
  const lines: string[] = [
    '---',
    '',
    `## Interview ${position + 1}`,
    '',
    `- Interview ID: ${escapeMarkdownInline(interview.id)}`,
    `- Started: ${isoUtc(interview.createdAt)}`,
    `- Completed: ${isoUtc(interview.completedAt)}`,
    ...(interview.studyRevision !== undefined ? [`- Study revision: ${interview.studyRevision}`] : []),
    `- ${participantTermsLine(interview)}`,
    ...[interviewLanguageLine(interview), voiceInputLine(interview)].flatMap((line) => (line ? [`- ${escapeMarkdownInline(line)}`] : [])),
    '',
  ];

  const fields = interview.participantProfile?.fields ?? [];
  if (fields.length > 0) {
    lines.push('### Participant profile', '');
    for (const field of fields) {
      const label = interview.collectionConfig?.profileSchema.find((entry) => entry.id === field.fieldId)?.label ?? field.fieldId;
      const value = field.status === 'extracted' && field.value !== null ? field.value : `(${field.status})`;
      lines.push(`- ${escapeMarkdownInline(label)}: ${escapeMarkdownInline(value)}`);
    }
    lines.push('');
    if (interview.participantProfile.rawContext) {
      lines.push('Context noted during the interview:', '', quoteBlock(interview.participantProfile.rawContext), '');
    }
  }

  lines.push('### Conversation', '');
  let turn = 0;
  for (const message of interview.transcript) {
    if (message.role === 'system') continue;
    turn += 1;
    const speaker = message.role === 'user' ? 'Participant' : 'Interviewer';
    lines.push(`#### ${turn}. ${speaker} (${isoUtc(message.timestamp)})`, '', quoteBlock(message.content), '');
  }
  if (turn === 0) lines.push('No conversation turns were saved.', '');
  return `${lines.join('\n')}\n`;
}

export function transcriptsMarkdownFooter(count: number): string {
  return `---\n\n${transcriptsCompleteMarker(count)}\n`;
}

export function buildTranscriptsMarkdown(study: StoredStudy, interviews: StoredInterview[], exportedAt: Date): string {
  return [
    transcriptsMarkdownHeader(study, interviews.length, exportedAt),
    ...interviews.map((interview, index) => transcriptsMarkdownInterview(interview, index)),
    transcriptsMarkdownFooter(interviews.length),
  ].join('');
}

/** `<slug>-transcripts.md`, with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function transcriptsContentDisposition(studyName: string, studyId: string): string {
  const base = (studyName || '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const ascii = base.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fallback = `${ascii || `study-${studyId.slice(0, 8).toLowerCase()}`}-transcripts.md`;
  const utf8 = `${base || `study-${studyId.slice(0, 8)}`}-transcripts.md`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

export type TranscriptsMarkdownStreamInput = {
  header: string;
  /** Interviews in export order; may throw to abandon the file. */
  interviews: AsyncIterable<StoredInterview[]>;
  /** Called after the last interview, before the closing marker. Throw to abandon the file. */
  beforeFinish?: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/**
 * The file as a byte stream. Like the ZIP writer (zipStream.ts), the producer
 * starts at once and writes through a byte-bounded queue, so it waits while
 * the client reads slowly. Any failure aborts the stream before the closing
 * marker is written, so a truncated download never looks complete.
 */
export function createTranscriptsMarkdownStream(input: TranscriptsMarkdownStreamInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
  );
  const writer = transform.writable.getWriter();
  const run = async () => {
    await writer.write(encoder.encode(input.header));
    let position = 0;
    for await (const page of input.interviews) {
      const chunk = page.map((interview) => transcriptsMarkdownInterview(interview, position++)).join('');
      if (chunk) await writer.write(encoder.encode(chunk));
    }
    if (input.beforeFinish) await input.beforeFinish();
    await writer.write(encoder.encode(transcriptsMarkdownFooter(position)));
    await writer.close();
  };
  run().catch(async (error: unknown) => {
    try {
      input.onError?.(error);
    } catch {
      // A throwing observer must not keep the stream open.
    }
    await writer.abort(error).catch(() => undefined);
  });
  return transform.readable;
}
