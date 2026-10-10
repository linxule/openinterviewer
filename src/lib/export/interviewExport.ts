// Researcher ZIP export content (ST-08, RT-09). The one copy of the entry
// builders: src/app/api/interviews/export/route.ts imports them for the Node
// JSZip archive and for the Cloudflare streaming archive, so both targets
// produce the same entries with the same decompressed bytes: per interview
// NNN_<date>_<id8>.json and .md, then aggregates/<studyId>.json (with JSZip's
// implicit aggregates/ folder entry), then summary.csv with formula-safe
// cells, plus snapshot-only analysis files (analysisFiles.ts). The parity tests (zipStream.test.ts, api.export.durable.test.ts)
// compare the two archives entry by entry.

import type { StoredAggregateSynthesis, StoredInterview } from '@/types';
import type { ExplorationAnswer } from '@/lib/exploration/types';
import { analysisCsvHeader, analysisInterviewsHeaderParts, analysisInterviewsRow, analysisJsonLine, analysisProfileRows, analysisReadmeParts, analysisTextChunks, analysisTurnsCsv, analysisTurnsName, collectProfileColumns, PROFILE_COLUMNS, sortedProfileColumns, type ProfileColumns } from './analysisFiles';
import { csvCell } from '@/lib/csv';
import { analysisStatus } from '@/lib/analysisState';
import { createZipStream, type ZipStreamLimits } from './zipStream';
import { interviewLanguageLine, quoteBlock } from './transcriptsMarkdown';

export const AGGREGATES_DIRECTORY = 'aggregates/';
export const EXPLORATIONS_DIRECTORY = 'explorations/';
export const SUMMARY_CSV_NAME = 'summary.csv';
export const SUMMARY_CSV_HEADER = 'Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight,Analysis';

// Generate markdown transcript for an interview
export function interviewTranscriptMarkdown(interview: StoredInterview): string {
  const lines = [
    `# Interview Transcript`,
    `Study: ${interview.studyName}`,
    `Interview ID: ${interview.id}`,
    `Date: ${new Date(interview.createdAt).toISOString()}`,
    `Duration: ${Math.round((interview.completedAt - interview.createdAt) / 1000 / 60)} minutes`,
    ...(interviewLanguageLine(interview) ? [interviewLanguageLine(interview)!] : []),
    ``
  ];

  // Add participant profile summary
  if (interview.participantProfile && interview.participantProfile.fields.length > 0) {
    lines.push(`## Participant Profile`);
    interview.participantProfile.fields.forEach(f => {
      const value = f.status === 'extracted' ? f.value : `(${f.status})`;
      const originalLabel = interview.collectionConfig?.profileSchema.find(field => field.id === f.fieldId)?.label;
      lines.push(`- **${originalLabel ?? f.fieldId}**: ${value}${interview.collectionConfig ? '' : ' (historical field definition unavailable)'}`);
    });
    if (interview.participantProfile.rawContext) {
      lines.push(``);
      lines.push(`**Context**:`);
      lines.push(quoteBlock(interview.participantProfile.rawContext));
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Conversation`);
  lines.push(``);

  interview.transcript.forEach(msg => {
    const time = new Date(msg.timestamp).toISOString();
    const role = msg.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER';
    lines.push(`[${time}] ${role}:`);
    // Quoted so transcript text cannot imitate a speaker line or a heading.
    lines.push(quoteBlock(msg.content));
    lines.push('');
  });

  if (interview.synthesis) {
    lines.push('---');
    lines.push('');
    lines.push('## Analysis Summary');
    lines.push('');
    lines.push(`**Key Insight:** ${interview.synthesis.bottomLine}`);
    lines.push('');
    if (interview.synthesis.themes.length > 0) {
      lines.push('**Themes:**');
      interview.synthesis.themes.forEach(t => {
        const support = t.evidence ?? (t.evidenceRefs ?? []).map(r => `"${r.quote}" (turn ${r.turnIndex})`).join('; ');
        lines.push(support ? `- ${t.theme}: ${support}` : `- ${t.theme}`);
      });
      lines.push('');
    }
    if (interview.synthesis.keyInsights.length > 0) {
      lines.push('**Key Insights:**');
      interview.synthesis.keyInsights.forEach(insight => {
        lines.push(`- ${insight}`);
      });
    }
  }

  return lines.join('\n');
}

/** `NNN_<yyyy-mm-dd>_<id8>`; `position` is zero-based in export order. */
export function interviewEntryBaseName(position: number, interview: StoredInterview): string {
  const paddedIndex = String(position + 1).padStart(3, '0');
  const date = new Date(interview.createdAt).toISOString().split('T')[0];
  return `${paddedIndex}_${date}_${interview.id.slice(0, 8)}`;
}

export function interviewJson(interview: StoredInterview): string {
  return JSON.stringify(interview, null, 2);
}

export function aggregateEntryName(studyId: string): string {
  return `${AGGREGATES_DIRECTORY}${studyId}.json`;
}

export function aggregateJson(aggregate: StoredAggregateSynthesis): string {
  return JSON.stringify(aggregate, null, 2);
}

export function explorationEntryName(answer: ExplorationAnswer): string {
  return `${EXPLORATIONS_DIRECTORY}${answer.studyId}/${answer.id}.json`;
}

export function explorationJson(answer: ExplorationAnswer): string {
  return JSON.stringify(answer, null, 2);
}

export function summaryCsvRow(interview: StoredInterview): string {
  const duration = Math.round((interview.completedAt - interview.createdAt) / 1000 / 60);
  const themes = interview.synthesis?.themes.length || 0;
  const insight = interview.synthesis?.bottomLine || '';
  return `${csvCell(interview.id)},${csvCell(interview.studyName)},${csvCell(new Date(interview.createdAt).toISOString())},${duration},${interview.transcript.length},${themes},${csvCell(insight)},${csvCell(analysisStatus(interview))}`;
}

// ---------- Streaming composition ----------

/**
 * One page of export data. Interviews arrive in export order (newest first)
 * across pages; aggregates arrive in first-seen study order after them.
 */
export type InterviewExportPage = {
  interviews: StoredInterview[];
  aggregates: StoredAggregateSynthesis[];
  explorations?: ExplorationAnswer[];
};

/** Thrown by a page source when the snapshot fence reports a change. */
export class ExportSnapshotChangedError extends Error {
  constructor() {
    super('export snapshot changed');
    this.name = 'ExportSnapshotChangedError';
  }
}

export type InterviewExportStreamInput = {
  /** A fresh walk of the SAME snapshot on every invocation; never begin a new export. */
  pages: () => AsyncIterable<InterviewExportPage>;
  /**
   * Called after the last entry and before the central directory is written.
   * Throw (e.g. ExportSnapshotChangedError) to fail the archive instead.
   */
  beforeFinish?: () => Promise<void>;
  /** Invoked once with the failure when the archive is abandoned. */
  onError?: (error: unknown) => void;
  modifiedAt?: Date;
  limits?: Partial<ZipStreamLimits>;
};

/**
 * The export archive as a byte stream. A failure anywhere (page source,
 * sequence check, ZIP limit) errors the stream; the central directory is
 * only written after every page and `beforeFinish` succeeded, so a client
 * can never mistake a truncated download for a complete archive.
 * Replay the same bounded pages for combined analysis entries: no corpus-sized
 * strings or arrays are retained. Only the profile column dictionary survives a pass.
 */
export function createInterviewExportStream(input: InterviewExportStreamInput): ReadableStream<Uint8Array> {
  const zip = createZipStream({ modifiedAt: input.modifiedAt, limits: input.limits });
  const run = async () => {
    const columns: ProfileColumns = new Map();
    await zip.addDirectory('analysis/');
    await zip.addDirectory('analysis/turns/');
    const seenAggregates = new Set<string>();
    const seenExplorations = new Set<string>();
    let position = 0;
    const interviewIds: string[] = [];
    for await (const page of input.pages()) {
      for (const interview of page.interviews) {
        const baseName = interviewEntryBaseName(position, interview);
        position += 1;
        interviewIds.push(interview.id);
        await zip.addFile(`${baseName}.json`, interviewJson(interview));
        await zip.addFile(`${baseName}.md`, interviewTranscriptMarkdown(interview));
        await zip.addFile(analysisTurnsName(position - 1), analysisTurnsCsv(interview));
        collectProfileColumns(columns, interview);
      }
      for (const aggregate of page.aggregates) {
        if (seenAggregates.size === 0) await zip.addDirectory(AGGREGATES_DIRECTORY);
        if (seenAggregates.has(aggregate.studyId)) throw new TypeError('duplicate aggregate in export');
        seenAggregates.add(aggregate.studyId);
        await zip.addFile(aggregateEntryName(aggregate.studyId), aggregateJson(aggregate));
      }
      for (const answer of page.explorations ?? []) {
        const entryName = explorationEntryName(answer);
        if (seenExplorations.size === 0) await zip.addDirectory(EXPLORATIONS_DIRECTORY);
        if (seenExplorations.has(entryName)) throw new TypeError('duplicate exploration in export');
        seenExplorations.add(entryName);
        await zip.addFile(entryName, explorationJson(answer));
      }
    }
    const orderedColumns = sortedProfileColumns(columns);
    // Count and identity checks catch a broken replay source as well as missing pages.
    // Durable storage itself checks the snapshot fingerprint on each page read.
    async function* rows(header: string | Iterable<string>, row: (interview: StoredInterview) => string): AsyncGenerator<string> {
      if (typeof header === 'string') yield header;
      else yield* header;
      let count = 0;
      for await (const page of input.pages()) {
        for (const interview of page.interviews) {
          if (interview.id !== interviewIds[count]) throw new ExportSnapshotChangedError();
          count += 1;
          yield row(interview);
        }
      }
      if (count !== position) throw new ExportSnapshotChangedError();
    }
    await zip.addFile(SUMMARY_CSV_NAME, rows(SUMMARY_CSV_HEADER, interview => `\n${summaryCsvRow(interview)}`));
    await zip.addFile('analysis/interviews.jsonl', rows('', analysisJsonLine));
    await zip.addFile('analysis/interviews.csv', rows(analysisTextChunks(analysisInterviewsHeaderParts(orderedColumns)), interview => analysisInterviewsRow(interview, orderedColumns)));
    await zip.addFile('analysis/profile_fields.csv', rows(analysisCsvHeader(PROFILE_COLUMNS), analysisProfileRows));
    await zip.addFile('analysis/README.md', analysisTextChunks(analysisReadmeParts(orderedColumns)));
    if (input.beforeFinish) await input.beforeFinish();
    await zip.finish();
  };
  run().catch(async (error: unknown) => {
    try {
      input.onError?.(error);
    } catch {
      // A throwing observer must never leave the archive open: abort below.
    }
    await zip.abort(error);
  });
  return zip.readable;
}
