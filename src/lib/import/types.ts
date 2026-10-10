/** Parsing is not consent, role assignment, sanitisation, or an evidence manifest. */
export interface ImportedTurn {
  speaker: string;
  text: string;
  startMs?: number;
  endMs?: number;
}
export interface ImportedTranscript {
  turns: ImportedTurn[];
  warnings: string[];
}
export type ImportErrorCode = 'FILE_TOO_LARGE' | 'TOO_MANY_TURNS' | 'TEXT_TOO_LARGE'
  | 'MALFORMED_INPUT' | 'UNSUPPORTED_FORMAT' | 'UNSAFE_ARCHIVE' | 'ARCHIVE_LIMIT';
export class TranscriptImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    // Never include uploaded content, filenames, XML, or ZIP paths in errors.
    super(`Transcript import failed: ${code}`);
    this.name = 'TranscriptImportError';
  }
}
export const IMPORT_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  textBytes: 1024 * 1024,
  turnBytes: 64 * 1024,
  turns: 10_000, // Counts source cues/paragraphs BEFORE merging.
  speakerChars: 200,
  archiveEntries: 256,
  archiveExpandedBytes: 8 * 1024 * 1024,
  documentBytes: 2 * 1024 * 1024,
  expansionRatio: 100,
  xmlDepth: 64,
  xmlNodes: 100_000,
});
export function fail(code: ImportErrorCode): never { throw new TranscriptImportError(code); }
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('MALFORMED_INPUT'); }
}
export function inputText(input: string | Uint8Array): string {
  if (typeof input === 'string' && input.length > IMPORT_LIMITS.fileBytes) fail('FILE_TOO_LARGE');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > IMPORT_LIMITS.fileBytes) fail('FILE_TOO_LARGE');
  const text = utf8(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\0')) fail('MALFORMED_INPUT');
  return text;
}

/** Conservative label heuristic: mapping remains a researcher decision. */
export function labelled(text: string): Pick<ImportedTurn, 'speaker' | 'text'> {
  const match = /^([^\n:]{1,200}):[ \t]+([\s\S]+)$/.exec(text);
  return match ? { speaker: match[1].trim(), text: match[2] } : { speaker: 'Unknown', text };
}

export function collector() {
  const turns: ImportedTurn[] = [];
  const warnings = new Set<string>();
  let count = 0;
  let total = 0;
  let lastStart = -1;
  let previousBytes = 0;
  return {
    warnings,
    add(turn: ImportedTurn) {
      if (++count > IMPORT_LIMITS.turns) fail('TOO_MANY_TURNS');
      if (!turn.text.trim() || !turn.speaker.trim()) fail('MALFORMED_INPUT');
      if (turn.speaker.length > IMPORT_LIMITS.speakerChars) fail('TEXT_TOO_LARGE');
      const size = new TextEncoder().encode(turn.text).length;
      total += size;
      if (size > IMPORT_LIMITS.turnBytes || total > IMPORT_LIMITS.textBytes) fail('TEXT_TOO_LARGE');
      if (turn.startMs !== undefined) {
        if (turn.startMs < lastStart) fail('MALFORMED_INPUT');
        lastStart = turn.startMs;
      }
      if (turn.speaker === 'Unknown') warnings.add('UNMAPPED_SPEAKER');
      const previous = turns[turns.length - 1];
      // Unknown is not a known speaker identity. Never coalesce ambiguous speech.
      if (previous && turn.speaker !== 'Unknown' && previous.speaker === turn.speaker) {
        if (previousBytes + size + 1 > IMPORT_LIMITS.turnBytes) fail('TEXT_TOO_LARGE');
        previous.text += '\n' + turn.text;
        previousBytes += size + 1;
        total += 1;
        if (total > IMPORT_LIMITS.textBytes) fail('TEXT_TOO_LARGE');
        if (turn.endMs !== undefined) previous.endMs = Math.max(previous.endMs ?? 0, turn.endMs);
        warnings.add('CONSECUTIVE_CUES_MERGED');
      } else {
        turns.push({ ...turn });
        previousBytes = size;
      }
    },
    finish(): ImportedTranscript {
      if (!turns.length) fail('MALFORMED_INPUT');
      return { turns, warnings: [...warnings] };
    },
  };
}
