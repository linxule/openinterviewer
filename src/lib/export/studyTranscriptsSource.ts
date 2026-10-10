// Shared authorized-store sources. Callers own researcher authorization; this module
// rechecks canonical study readability and the backend's snapshot/deletion guards.
import { NextResponse } from 'next/server';
import type { StoredStudy, StoredInterview } from '@/types';
import { mapCollectionLoad, mapStudyLoad } from '@/lib/ownedStudies';
import { isDurableWorkspaceStore, type DurableWorkspaceStorePort, type WorkspaceStorePort, type ExportPage } from '@/lib/storage/types';
import { studyMutationReadiness, STUDY_DELETION_PENDING_CODE, STUDY_DELETION_PENDING_MESSAGE } from '@/lib/studyMutationReadiness';
import { MAX_EXPLORATION_ANSWERS } from '@/lib/exploration/types';
import { ExportSnapshotChangedError, type InterviewExportPage } from './interviewExport';
import { buildTranscriptsMarkdown, createTranscriptsMarkdownStream, transcriptsMarkdownHeader } from './transcriptsMarkdown';
import { logRequestFailure } from '@/lib/requestLog';

export const MAX_EXPORT_INTERVIEWS = 500;
export const TOO_LARGE_STUDY_MESSAGE = 'This study is too large for an interactive download. Use an operator backup to retain the complete dataset.';
export type StudyTranscriptsSource = { study: StoredStudy; count: number; body: string | ReadableStream<Uint8Array> };
function emptySource(study: StoredStudy): StudyTranscriptsSource {
  return { study, count: 0, body: buildTranscriptsMarkdown(study, [], new Date()) };
}
export async function exportMutationRefusal(store: WorkspaceStorePort, studyIds: string[], scopedStart = false): Promise<Response | null> {
  for (const studyId of new Set(studyIds)) {
    const status = await studyMutationReadiness(store, studyId);
    if (status === 'ready') continue;
    if (status === 'missing') return scopedStart
      ? NextResponse.json({ error: 'Study not found' }, { status: 404 }) : exportChangedResponse();
    if (status === 'deleting') return NextResponse.json({ error: STUDY_DELETION_PENDING_MESSAGE, code: STUDY_DELETION_PENDING_CODE, retryable: true }, { status: 409 });
    return exportUnavailableResponse();
  }
  return null;
}

/** Rows per export page; the object caps pages at 200 rows. */
export const EXPORT_PAGE_SIZE = 50;
/** Stored bytes per export page; bounded well below the object's 16 MiB page cap. */
export const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
// Memory: the ZIP writer pulls a page only when its output is read, and the
// Worker's OpenNext wrapper (cloudflare/opennext/backpressureWrapper.ts)
// passes the client's read rate back through Next's pipe, so a slow download
// holds a bounded window rather than the whole archive. Only the ZIP32
// structural limits apply; the 500-interview ceiling is checked up front.

/** A page read or the final check could not be completed; the archive is abandoned. */
export class ExportStorageUnavailableError extends Error {
  constructor() {
    super('export storage unavailable');
    this.name = 'ExportStorageUnavailableError';
  }
}

export function exportChangedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'The interviews changed while the export was being prepared. Try the export again.',
      code: 'EXPORT_CHANGED',
      retryable: true,
    },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function exportUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Interview storage is temporarily unavailable.', retryable: true },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * The snapshot's pages after the first, which was read before the response
 * started. Throws ExportSnapshotChangedError when a captured interview or
 * aggregate can no longer be reproduced, and ExportStorageUnavailableError
 * when a page cannot be read or makes no progress.
 */
export async function* remainingExportPages(
  store: DurableWorkspaceStorePort,
  sequence: number,
  first: Extract<ExportPage, { status: 'ok' }>,
  maximumPages: number,
  studyId?: string,
): AsyncGenerator<InterviewExportPage> {
  let page = first;
  for (let pages = 1; ; pages += 1) {
    yield { interviews: page.interviews, aggregates: page.aggregates, explorations: page.explorations };
    const cursor = page.nextCursor;
    if (cursor === null) return;
    if (pages >= maximumPages) throw new ExportStorageUnavailableError();
    const next = await store.readExportPage({ sequence, cursor, pageSize: EXPORT_PAGE_SIZE, maxPageBytes: EXPORT_PAGE_BYTES, ...(studyId ? { studyId } : {}) });
    if (next.status === 'changed') throw new ExportSnapshotChangedError();
    if (next.status !== 'ok' || next.nextCursor === cursor) throw new ExportStorageUnavailableError();
    page = next;
  }
}

const NO_TRANSCRIPTS_MESSAGE = 'This study has no saved interviews to export.';

async function* interviewPages(pages: AsyncIterable<InterviewExportPage>, count: number, studyId: string): AsyncGenerator<StoredInterview[]> {
  let emitted = 0;
  for await (const page of pages) {
    emitted += page.interviews.length;
    if (emitted > count || page.interviews.some(interview => interview.studyId !== studyId)) throw new ExportStorageUnavailableError();
    yield page.interviews;
  }
  if (emitted !== count) throw new ExportStorageUnavailableError();
}

async function durableSource(store: DurableWorkspaceStorePort, study: StoredStudy, maximum: number, allowEmpty: boolean): Promise<StudyTranscriptsSource | Response> {
  const scope = { studyId: study.id };
  const begun = await store.beginExport({ maximum, ...scope });
  if (begun.status === 'empty' && allowEmpty) return emptySource(study);
  if (begun.status === 'empty') {
    return NextResponse.json({ error: NO_TRANSCRIPTS_MESSAGE }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status === 'too-large') {
    return NextResponse.json({ error: TOO_LARGE_STUDY_MESSAGE }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status !== 'ok') return exportUnavailableResponse();
  if (begun.count === 0 && allowEmpty) return emptySource(study);
  if (begun.count === 0) {
    return NextResponse.json({ error: NO_TRANSCRIPTS_MESSAGE }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const sequence = begun.sequence;
  const first = await store.readExportPage({ sequence, cursor: null, pageSize: EXPORT_PAGE_SIZE, maxPageBytes: EXPORT_PAGE_BYTES, ...scope });
  if (first.status === 'changed') return exportChangedResponse();
  if (first.status !== 'ok') return exportUnavailableResponse();

  const maximumPages = begun.count + begun.studyIds.length + MAX_EXPLORATION_ANSWERS + 1;
  const body = createTranscriptsMarkdownStream({
    header: transcriptsMarkdownHeader(study, begun.count, new Date()),
    interviews: interviewPages(remainingExportPages(store, sequence, first, maximumPages, study.id), begun.count, study.id),
    beforeFinish: async () => {
      const verified = await store.verifyExportSequence({ sequence, ...scope });
      if (verified === 'changed') throw new ExportSnapshotChangedError();
      if (verified !== 'unchanged') throw new ExportStorageUnavailableError();
    },
    onError: (error) => {
      logRequestFailure({
        event: 'route.failure',
        route: '/api/interviews/export',
        method: 'GET',
        ...(error instanceof ExportStorageUnavailableError ? { reason: 'unavailable' } : {}),
      }, error);
    },
  });
  return { study, count: begun.count, body };
}


export async function prepareStudyTranscriptsSource(store: WorkspaceStorePort, studyId: string, maximum = MAX_EXPORT_INTERVIEWS, allowEmpty = false): Promise<StudyTranscriptsSource | Response> {
  const mutationRefusal = await exportMutationRefusal(store, [studyId], true);
  if (mutationRefusal) return mutationRefusal;
  const study = mapStudyLoad(await store.getStudy(studyId));
  if (!study.ok) return NextResponse.json(study.body, { status: study.status });
  if (isDurableWorkspaceStore(store)) return durableSource(store, study.study, maximum, allowEmpty);
  const loaded = mapCollectionLoad(await store.listInterviews({ scope: 'study', studyId, maximum }), { unavailable: 'Interview storage is temporarily unavailable.', tooLarge: TOO_LARGE_STUDY_MESSAGE });
  if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });
  if (loaded.items.length === 0 && !allowEmpty) return NextResponse.json({ error: NO_TRANSCRIPTS_MESSAGE }, { status: 404 });
  const markdown = buildTranscriptsMarkdown(study.study, loaded.items, new Date());
  const refusal = await exportMutationRefusal(store, [studyId]);
  if (refusal) return refusal;
  return { study: study.study, count: loaded.items.length, body: markdown };
}
