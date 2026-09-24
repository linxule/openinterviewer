// GET /api/interviews/export - Export all interviews as ZIP
// Protected: Requires authenticated session
//
// Node (standalone Redis, hosted BYOS): the archive is built in memory with
// JSZip from at most 500 interviews. Cloudflare (workspace Durable Object):
// the same entries are streamed page by page from an export snapshot
// (RT-09, ST-08, gap F1); a snapshot change before the response starts is 409
// EXPORT_CHANGED, and after it errors the stream so the archive's closing
// records are never written. The platform may still end such a body as a
// clean 200, so the client (storageService.exportAllInterviewsChecked)
// refuses any download without those records.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getStudyAggregateChecked, type AggregateLoadResult } from '@/lib/kv';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { isHostedMode } from '@/lib/mode';
import {
  inspectOwnedStudyGates,
  loadAllowedInterviews,
  mapCollectionLoad,
} from '@/lib/ownedStudies';
import JSZip from 'jszip';
import { StoredInterview, StoredAggregateSynthesis } from '@/types';
import { logRequestFailure } from '@/lib/requestLog';
import {
  aggregateEntryName,
  aggregateJson,
  createInterviewExportStream,
  ExportSnapshotChangedError,
  interviewEntryBaseName,
  interviewJson,
  interviewTranscriptMarkdown,
  SUMMARY_CSV_HEADER,
  SUMMARY_CSV_NAME,
  summaryCsvRow,
  type InterviewExportPage,
} from '@/lib/export/interviewExport';
import { ZipLimitError } from '@/lib/export/zipStream';
import { isDurableWorkspaceStore, type DurableWorkspaceStorePort, type ExportPage } from '@/lib/storage/types';

async function loadStudyAggregates(
  interviews: StoredInterview[],
  loadAggregate: (studyId: string) => Promise<AggregateLoadResult>,
): Promise<Map<string, StoredAggregateSynthesis> | 'unavailable'> {
  const aggregates = new Map<string, StoredAggregateSynthesis>();
  for (const studyId of new Set(interviews.map(interview => interview.studyId))) {
    const loaded = await loadAggregate(studyId);
    if (loaded.status === 'unavailable') return 'unavailable';
    if (loaded.status === 'found') aggregates.set(studyId, loaded.aggregate);
  }
  return aggregates;
}

// Interactive export ceiling on every backend; larger exports are refused (413), never truncated.
const MAX_EXPORT_INTERVIEWS = 500;
const TOO_LARGE_MESSAGE = 'This export is too large for an interactive download. Export a smaller study set.';

function pendingExportResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'A study operation is already in progress.',
      code: 'STUDY_OPERATION_PENDING',
      retryable: true,
    },
    { status: 409 },
  );
}

async function buildExportResponse(
  interviews: StoredInterview[],
  aggregates: Map<string, StoredAggregateSynthesis>,
): Promise<Response> {
  const zip = new JSZip();

  // Entry names and contents come from the builders the Cloudflare stream
  // uses, so the two archives cannot drift apart.
  interviews.forEach((interview, index) => {
    const baseName = interviewEntryBaseName(index, interview);
    zip.file(`${baseName}.json`, interviewJson(interview));
    zip.file(`${baseName}.md`, interviewTranscriptMarkdown(interview));
  });

  for (const [studyId, aggregate] of aggregates) {
    zip.file(aggregateEntryName(studyId), aggregateJson(aggregate));
  }

  const csvLines = [SUMMARY_CSV_HEADER, ...interviews.map(summaryCsvRow)];
  zip.file(SUMMARY_CSV_NAME, csvLines.join('\n'));

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return new Response(zipBlob, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=interviews-export-${Date.now()}.zip`,
    },
  });
}

// ---------- Cloudflare: streamed export over the durable snapshot ----------

/** Rows per export page; the object caps pages at 200 rows. */
const EXPORT_PAGE_SIZE = 50;
/** Stored bytes per export page; bounded well below the object's 16 MiB page cap. */
const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
// Memory: the ZIP writer pulls a page only when its output is read, and the
// Worker's OpenNext wrapper (cloudflare/opennext/backpressureWrapper.ts)
// passes the client's read rate back through Next's pipe, so a slow download
// holds a bounded window rather than the whole archive. Only the ZIP32
// structural limits apply; the 500-interview ceiling is checked up front.

/** A page read or the final check could not be completed; the archive is abandoned. */
class ExportStorageUnavailableError extends Error {
  constructor() {
    super('export storage unavailable');
    this.name = 'ExportStorageUnavailableError';
  }
}

function exportChangedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'The interviews changed while the export was being prepared. Try the export again.',
      code: 'EXPORT_CHANGED',
      retryable: true,
    },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  );
}

function exportUnavailableResponse(): NextResponse {
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
async function* remainingExportPages(
  store: DurableWorkspaceStorePort,
  sequence: number,
  first: Extract<ExportPage, { status: 'ok' }>,
  maximumPages: number,
): AsyncGenerator<InterviewExportPage> {
  let page = first;
  for (let pages = 1; ; pages += 1) {
    yield { interviews: page.interviews, aggregates: page.aggregates };
    const cursor = page.nextCursor;
    if (cursor === null) return;
    if (pages >= maximumPages) throw new ExportStorageUnavailableError();
    const next = await store.readExportPage({ sequence, cursor, pageSize: EXPORT_PAGE_SIZE, maxPageBytes: EXPORT_PAGE_BYTES });
    if (next.status === 'changed') throw new ExportSnapshotChangedError();
    if (next.status !== 'ok' || next.nextCursor === cursor) throw new ExportStorageUnavailableError();
    page = next;
  }
}

async function streamDurableExport(store: DurableWorkspaceStorePort): Promise<Response> {
  const begun = await store.beginExport({ maximum: MAX_EXPORT_INTERVIEWS });
  if (begun.status === 'empty') {
    return NextResponse.json({ error: 'No interviews to export' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status === 'too-large') {
    return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status !== 'ok') return exportUnavailableResponse();

  // The first page is read before any header is sent, so a change or outage
  // this early is still an ordinary retryable response.
  const sequence = begun.sequence;
  const first = await store.readExportPage({ sequence, cursor: null, pageSize: EXPORT_PAGE_SIZE, maxPageBytes: EXPORT_PAGE_BYTES });
  if (first.status === 'changed') return exportChangedResponse();
  if (first.status !== 'ok') return exportUnavailableResponse();

  // Every page carries at least one row or aggregate, which bounds the walk.
  const maximumPages = begun.count + begun.studyIds.length + 1;
  const body = createInterviewExportStream({
    pages: remainingExportPages(store, sequence, first, maximumPages),
    beforeFinish: async () => {
      const verified = await store.verifyExportSequence({ sequence });
      if (verified === 'changed') throw new ExportSnapshotChangedError();
      if (verified !== 'unchanged') throw new ExportStorageUnavailableError();
    },
    // Headers are gone: the stream errors (no central directory), and the
    // event carries only the error class (ExportSnapshotChangedError,
    // ExportStorageUnavailableError or ZipLimitError) and an allowlisted reason.
    onError: (error) => {
      const reason = error instanceof ExportStorageUnavailableError
        ? 'unavailable'
        : error instanceof ZipLimitError ? 'too-large' : undefined;
      logRequestFailure({
        event: 'route.failure',
        route: '/api/interviews/export',
        method: 'GET',
        ...(reason ? { reason } : {}),
      }, error);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=interviews-export-${Date.now()}.zip`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET() {
  try {
    if (isHostedMode()) {
      const identity = await getHostedResearcherIdentity();
      if (!identity.authorized || !identity.researcherId) {
        return NextResponse.json({ error: identity.error || 'Unauthorized' }, { status: 401 });
      }
      const inspection = await inspectOwnedStudyGates(identity.researcherId);
      const inspectionMapped = mapCollectionLoad(
        inspection.status === 'ok'
          ? { status: 'ok', items: [], pendingStudies: inspection.pendingStudies }
          : inspection,
        {
          unavailable: 'Interview storage is temporarily unavailable.',
          tooLarge: TOO_LARGE_MESSAGE,
        },
      );
      if (!inspectionMapped.ok) {
        return NextResponse.json(inspectionMapped.body, { status: inspectionMapped.status });
      }
      if (inspection.status !== 'ok' || inspection.allowedIds.length === 0) {
        if (inspection.status === 'ok' && inspection.pendingStudies.length > 0) {
          return pendingExportResponse();
        }
        return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
      }

      const access = await getRequestContext();
      const setupResponse = configurationRequiredResponse(access);
      if (setupResponse) return setupResponse;
      if (!access.authorized || !access.context) {
        return NextResponse.json({ error: access.error || 'Unauthorized' }, { status: 401 });
      }
      const loaded = await loadAllowedInterviews(inspection.allowedIds, access.context.kvClient, MAX_EXPORT_INTERVIEWS);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Interview storage is temporarily unavailable.',
        tooLarge: TOO_LARGE_MESSAGE,
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      if (mapped.items.length === 0) {
        if (inspection.pendingStudies.length > 0) return pendingExportResponse();
        return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
      }
      const hostedKvClient = access.context.kvClient;
      const hostedAggregates = await loadStudyAggregates(
        mapped.items,
        (studyId) => getStudyAggregateChecked(studyId, hostedKvClient),
      );
      if (hostedAggregates === 'unavailable') {
        return NextResponse.json(
          { error: 'Analysis storage is temporarily unavailable.', retryable: true },
          { status: 503 },
        );
      }
      return buildExportResponse(mapped.items, hostedAggregates);
    }

    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }
    const store = context.store;
    if (isDurableWorkspaceStore(store)) return await streamDurableExport(store);

    const loaded = await store.listInterviews({ scope: 'all', maximum: MAX_EXPORT_INTERVIEWS });
    const mapped = mapCollectionLoad(loaded, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: TOO_LARGE_MESSAGE,
    });
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    if (mapped.items.length === 0) {
      return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
    }
    const standaloneAggregates = await loadStudyAggregates(mapped.items, (studyId) => store.getAggregate(studyId));
    if (standaloneAggregates === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    return buildExportResponse(mapped.items, standaloneAggregates);
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/interviews/export',
      method: 'GET',
      status: 503,
    }, error);
    return NextResponse.json(
      { error: 'Failed to export interviews' },
      { status: 503 }
    );
  }
}
