// GET /api/interviews/export - Export all interviews as ZIP, or with
// ?studyId=…&format=markdown one study's transcripts as a single Markdown file
// (src/lib/export/transcriptsMarkdown.ts).
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
import { getAuthorizedResearcherStudyContext, getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { isHostedMode } from '@/lib/mode';
import {
  inspectOwnedStudyGates,
  loadAllowedInterviews,
  mapCollectionLoad,
  mapStudyLoad,
  MAX_OWNED_STUDIES,
} from '@/lib/ownedStudies';
import JSZip from 'jszip';
import { StoredInterview, StoredAggregateSynthesis, type StoredStudy } from '@/types';
import { logRequestFailure } from '@/lib/requestLog';
import {
  aggregateEntryName,
  aggregateJson,
  explorationEntryName,
  explorationJson,
  createInterviewExportStream,
  ExportSnapshotChangedError,
  interviewEntryBaseName,
  interviewJson,
  interviewTranscriptMarkdown,
  SUMMARY_CSV_HEADER,
  SUMMARY_CSV_NAME,
  summaryCsvRow,
} from '@/lib/export/interviewExport';
import { ZipLimitError } from '@/lib/export/zipStream';
import {
  transcriptsContentDisposition,
  TRANSCRIPTS_MARKDOWN_CONTENT_TYPE,
} from '@/lib/export/transcriptsMarkdown';
import { isDurableWorkspaceStore, type DurableWorkspaceStorePort, type WorkspaceStorePort } from '@/lib/storage/types';
import { MAX_EXPLORATION_ANSWERS, type ExplorationAnswer } from '@/lib/exploration/types';
import { prepareStudyTranscriptsSource, exportMutationRefusal, exportChangedResponse, exportUnavailableResponse, remainingExportPages, ExportStorageUnavailableError, EXPORT_PAGE_SIZE, EXPORT_PAGE_BYTES } from '@/lib/export/studyTranscriptsSource';

async function loadStudyAggregates(
  studyIds: string[],
  loadAggregate: (studyId: string) => Promise<AggregateLoadResult>,
): Promise<Map<string, StoredAggregateSynthesis> | 'unavailable'> {
  const aggregates = new Map<string, StoredAggregateSynthesis>();
  for (const studyId of new Set(studyIds)) {
    const loaded = await loadAggregate(studyId);
    if (loaded.status === 'unavailable') return 'unavailable';
    if (loaded.status === 'found') aggregates.set(studyId, loaded.aggregate);
  }
  return aggregates;
}

// Interactive export ceiling on every backend; larger exports are refused (413), never truncated.
const MAX_EXPORT_INTERVIEWS = 500;
const TOO_LARGE_MESSAGE = 'This export is too large for an interactive download. Export a smaller study set.';
const TOO_LARGE_STUDY_MESSAGE = 'This study is too large for an interactive download. Use an operator backup to retain the complete dataset.';

async function loadExplorations(store: WorkspaceStorePort, studyIds: string[]): Promise<ExplorationAnswer[] | 'unavailable' | 'too-large'> {
  if (!store.exploration) return [];
  const answers: ExplorationAnswer[] = [];
  for (const studyId of studyIds) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const seenAnswers = new Set<string>();
    // The page API caps output independently of the lifetime answer ceiling.
    // Exhaust every page, never mistake the first notebook page for all data.
    for (let page = 0; page <= MAX_EXPLORATION_ANSWERS; page += 1) {
      const loaded = await store.exploration.list({ studyId, maximum: MAX_EXPLORATION_ANSWERS, pageSize: 25, ...(cursor ? { cursor } : {}) });
      if (loaded.status !== 'ok') return loaded.status;
      for (const answer of loaded.answers) {
        if (answer.studyId !== studyId || seenAnswers.has(answer.id)) return 'unavailable';
        seenAnswers.add(answer.id);
        answers.push(answer);
      }
      if (answers.length > MAX_EXPLORATION_ANSWERS) return 'too-large';
      if (!loaded.nextCursor) break;
      if (loaded.answers.length === 0 || seenCursors.has(loaded.nextCursor)) return 'unavailable';
      seenCursors.add(loaded.nextCursor);
      cursor = loaded.nextCursor;
      if (page === MAX_EXPLORATION_ANSWERS) return 'unavailable';
    }
  }
  return answers;
}

function pendingExportResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'A complete workspace export is unavailable while a study operation is in progress. Retry after reconciliation, or export an individual study that is not pending.',
      code: 'STUDY_OPERATION_PENDING',
      retryable: true,
    },
    { status: 409 },
  );
}

async function buildExportResponse(
  interviews: StoredInterview[],
  aggregates: Map<string, StoredAggregateSynthesis>,
  explorations: ExplorationAnswer[] = [],
  beforeReturn?: () => Promise<Response | null>,
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
  for (const answer of explorations) {
    zip.file(explorationEntryName(answer), explorationJson(answer));
  }

  const csvLines = [SUMMARY_CSV_HEADER, ...interviews.map(summaryCsvRow)];
  zip.file(SUMMARY_CSV_NAME, csvLines.join('\n'));

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const refusal = await beforeReturn?.();
  if (refusal) return refusal;
  return new Response(zipBlob, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=interviews-export-${Date.now()}.zip`,
    },
  });
}

// ---------- Cloudflare: streamed export over the durable snapshot ----------

async function streamDurableExport(store: DurableWorkspaceStorePort, studyId?: string): Promise<Response> {
  const scope = studyId ? { studyId } : {};
  const begun = await store.beginExport({ maximum: MAX_EXPORT_INTERVIEWS, ...scope });
  if (begun.status === 'empty') {
    return NextResponse.json({ error: 'No interviews to export' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status === 'too-large') {
    return NextResponse.json({ error: studyId ? TOO_LARGE_STUDY_MESSAGE : TOO_LARGE_MESSAGE }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  if (begun.status !== 'ok') return exportUnavailableResponse();

  // The first page is read before any header is sent, so a change or outage
  // this early is still an ordinary retryable response.
  const sequence = begun.sequence;
  const first = await store.readExportPage({ sequence, cursor: null, pageSize: EXPORT_PAGE_SIZE, maxPageBytes: EXPORT_PAGE_BYTES, ...scope });
  if (first.status === 'changed') return exportChangedResponse();
  if (first.status !== 'ok') return exportUnavailableResponse();

  // Every page carries at least one row or aggregate, which bounds the walk.
  const maximumPages = begun.count + begun.studyIds.length + MAX_EXPLORATION_ANSWERS + 1;
  const body = createInterviewExportStream({
    pages: remainingExportPages(store, sequence, first, maximumPages, studyId),
    beforeFinish: async () => {
      const verified = await store.verifyExportSequence({ sequence, ...scope });
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

// ---------- One study's transcripts as a single Markdown file ----------

function markdownResponse(body: BodyInit, study: StoredStudy): Response {
  return new Response(body, {
    headers: {
      'Content-Type': TRANSCRIPTS_MARKDOWN_CONTENT_TYPE,
      'Content-Disposition': transcriptsContentDisposition(study.config.name, study.id),
      'Cache-Control': 'no-store',
    },
  });
}

async function exportStudyMarkdown(studyId: string): Promise<Response> {
  const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
  const denied = configurationRequiredResponse(gated);
  if (denied) return denied;
  if (!gated.authorized || !gated.context) {
    return NextResponse.json({ error: gated.error || 'Unauthorized', retryable: gated.retryable, ...(gated.code ? { code: gated.code } : {}) }, { status: gated.statusCode ?? 401 });
  }
  const source = await prepareStudyTranscriptsSource(gated.context.store, studyId);
  if (source instanceof Response) return source;
  return markdownResponse(source.body, source.study);
}

export async function GET(request?: Request) {
  try {
    const searchParams = request ? new URL(request.url).searchParams : null;
    const studyId = searchParams?.get('studyId') ?? null;
    const format = searchParams?.get('format') ?? null;
    if (format !== null && format !== 'zip' && format !== 'markdown') {
      return NextResponse.json({ error: 'Invalid export format' }, { status: 400 });
    }
    if (format === 'markdown') {
      if (studyId === null || !/^[A-Za-z0-9-]{1,128}$/.test(studyId)) {
        return NextResponse.json({ error: 'A Markdown export needs one valid study ID' }, { status: 400 });
      }
      return await exportStudyMarkdown(studyId);
    }
    if (studyId !== null) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(studyId)) {
        return NextResponse.json({ error: 'Invalid study ID' }, { status: 400 });
      }
      const gated = await getAuthorizedResearcherStudyContext(studyId, 'read');
      const denied = configurationRequiredResponse(gated);
      if (denied) return denied;
      if (!gated.authorized || !gated.context) {
        return NextResponse.json({ error: gated.error || 'Unauthorized', retryable: gated.retryable, ...(gated.code ? { code: gated.code } : {}) }, { status: gated.statusCode ?? 401 });
      }
      const store = gated.context.store;
      const mutationRefusal = await exportMutationRefusal(store, [studyId], true);
      if (mutationRefusal) return mutationRefusal;
      const study = mapStudyLoad(await store.getStudy(studyId));
      if (!study.ok) return NextResponse.json(study.body, { status: study.status });
      if (isDurableWorkspaceStore(store)) return await streamDurableExport(store, studyId);
      const loaded = mapCollectionLoad(await store.listInterviews({ scope: 'study', studyId, maximum: MAX_EXPORT_INTERVIEWS }), { unavailable: 'Interview storage is temporarily unavailable.', tooLarge: TOO_LARGE_STUDY_MESSAGE });
      if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });
      const aggregate = await store.getAggregate(studyId);
      if (aggregate.status === 'unavailable') return exportUnavailableResponse();
      const explorations = await loadExplorations(store, [studyId]);
      if (explorations === 'unavailable') return exportUnavailableResponse();
      if (explorations === 'too-large') return NextResponse.json({ error: TOO_LARGE_STUDY_MESSAGE }, { status: 413 });
      if (loaded.items.length === 0 && aggregate.status !== 'found' && explorations.length === 0) {
        return NextResponse.json({ error: 'No research data to export' }, { status: 404 });
      }
      return buildExportResponse(loaded.items, aggregate.status === 'found' ? new Map([[studyId, aggregate.aggregate]]) : new Map(), explorations,
        () => exportMutationRefusal(store, [studyId]));
    }
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
      if (inspection.status === 'ok' && inspection.pendingStudies.length > 0) return pendingExportResponse();
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
      const store = access.context.store;
      const mutationRefusal = await exportMutationRefusal(store, inspection.allowedIds);
      if (mutationRefusal) return mutationRefusal;
      const loaded = await loadAllowedInterviews(inspection.allowedIds, access.context.kvClient, MAX_EXPORT_INTERVIEWS);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Interview storage is temporarily unavailable.',
        tooLarge: TOO_LARGE_MESSAGE,
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      if (mapped.items.length === 0) {
        if (inspection.pendingStudies.length > 0) return pendingExportResponse();
      }
      const hostedKvClient = access.context.kvClient;
      const hostedAggregates = await loadStudyAggregates(
        inspection.allowedIds,
        (studyId) => getStudyAggregateChecked(studyId, hostedKvClient),
      );
      if (hostedAggregates === 'unavailable') {
        return NextResponse.json(
          { error: 'Analysis storage is temporarily unavailable.', retryable: true },
          { status: 503 },
        );
      }
      const explorations = await loadExplorations(store, inspection.allowedIds);
      if (explorations === 'unavailable') return exportUnavailableResponse();
      if (explorations === 'too-large') return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
      if (mapped.items.length === 0 && explorations.length === 0 && hostedAggregates.size === 0) return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
      return buildExportResponse(mapped.items, hostedAggregates, explorations,
        () => exportMutationRefusal(store, inspection.allowedIds));
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

    let studyIds: string[] = [];
    if (store.studyMutationStatus || store.exploration) {
      const studies = await store.listStudies(MAX_OWNED_STUDIES, { view: 'summary' });
      if (studies.status === 'too-large') return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
      if (studies.status !== 'ok') return exportUnavailableResponse();
      studyIds = studies.items.map(study => study.id);
      const mutationRefusal = await exportMutationRefusal(store, studyIds);
      if (mutationRefusal) return mutationRefusal;
    }
    const loaded = await store.listInterviews({ scope: 'all', maximum: MAX_EXPORT_INTERVIEWS });
    const mapped = mapCollectionLoad(loaded, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: TOO_LARGE_MESSAGE,
    });
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    studyIds = [...new Set([...studyIds, ...mapped.items.map(interview => interview.studyId)])];
    const sourceRefusal = await exportMutationRefusal(store, studyIds);
    if (sourceRefusal) return sourceRefusal;
    const standaloneAggregates = await loadStudyAggregates(studyIds, (studyId) => store.getAggregate(studyId));
    if (standaloneAggregates === 'unavailable') {
      return NextResponse.json(
        { error: 'Analysis storage is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }
    const explorations = await loadExplorations(store, studyIds);
    if (explorations === 'unavailable') return exportUnavailableResponse();
    if (explorations === 'too-large') return NextResponse.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });
    if (mapped.items.length === 0 && explorations.length === 0 && standaloneAggregates.size === 0) return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
    return buildExportResponse(mapped.items, standaloneAggregates, explorations,
      () => exportMutationRefusal(store, studyIds));
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
