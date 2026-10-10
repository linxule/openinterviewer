import type { Project } from '@/lib/projects/types';
import type { StudyTranscriptsSource } from './studyTranscriptsSource';
import { escapeMarkdownInline } from './transcriptsMarkdown';

export function projectTranscriptsCompleteMarker(studies: number, interviews: number): string {
  return `<!-- openinterviewer-project-export complete: ${studies} studies; ${interviews} interviews -->`;
}

/** Only the distinct final marker, matching the manifest and every inner footer, proves completion. */
export function hasProjectTranscriptsCompleteMarker(text: string): boolean {
  const lines = text.trimEnd().split('\n');
  const final = /^<!-- openinterviewer-project-export complete: (\d+) studies; (\d+) interviews -->$/.exec(lines.at(-1) ?? '');
  const header = lines.filter(line => /^<!-- openinterviewer-project-export studies: \d+ -->$/.test(line));
  const members = [...text.matchAll(/^<!-- openinterviewer-project-export study: ([A-Za-z0-9-]+); (\d+) interviews -->$/gm)];
  const inner = [...text.matchAll(/^<!-- openinterviewer-export complete: (\d+) interviews? -->$/gm)];
  if (!final || header.length !== 1 || header[0] !== `<!-- openinterviewer-project-export studies: ${final[1]} -->`) return false;
  return members.length === Number(final[1]) && new Set(members.map(m => m[1])).size === members.length
    && inner.length === members.length && members.every((m, i) => m[2] === inner[i][1])
    && members.reduce((sum, m) => sum + Number(m[2]), 0) === Number(final[2])
    && Number(final[2]) > 0 && Number(final[2]) <= 500;
}

/** One active study reader and a byte-bounded queue; cancellation reaches that reader. */
export function createProjectTranscriptsStream(input: {
  project: Project;
  studyIds: string[];
  prepare: (studyId: string, remaining: number) => Promise<StudyTranscriptsSource>;
  beforeFinish: () => Promise<void>;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }));
  const writer = transform.writable.getWriter();
  let active: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  void writer.closed.catch(async error => { cancelled = true; await active?.cancel(error).catch(() => undefined); });
  const write = (text: string) => writer.write(encoder.encode(text));
  const run = async () => {
    await write(`# ${escapeMarkdownInline(input.project.name)}: project transcripts\n\n- Project ID: ${input.project.id}\n- Exported: ${new Date().toISOString()}\n\n<!-- openinterviewer-project-export studies: ${input.studyIds.length} -->\n\n`);
    let count = 0;
    for (const id of input.studyIds) {
      if (cancelled) return;
      const source = await input.prepare(id, 500 - count);
      if (cancelled) { if (typeof source.body !== 'string') await source.body.cancel(); return; }
      count += source.count;
      if (count > 500) { if (typeof source.body !== 'string') await source.body.cancel(); throw new Error('Project export exceeds 500 interviews'); }
      if (typeof source.body !== 'string') active = source.body.getReader();
      try {
        await write(`---\n\n<!-- openinterviewer-project-export study: ${id}; ${source.count} interviews -->\n\n`);
        if (typeof source.body === 'string') await write(source.body);
        else {
          for (;;) {
            const next = await active!.read();
            if (next.done) break;
            await writer.write(next.value);
          }
        }
      } finally {
        if (active) { await active.cancel().catch(() => undefined); active.releaseLock(); active = undefined; }
      }
    }
    await input.beforeFinish();
    if (count === 0) throw new Error('No project transcripts');
    await write(`\n${projectTranscriptsCompleteMarker(input.studyIds.length, count)}\n`);
    await writer.close();
  };
  void run().catch(error => writer.abort(error).catch(() => undefined));
  return transform.readable;
}
