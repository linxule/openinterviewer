// GET /api/interviews/export - Export all interviews as ZIP
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getAllInterviewsChecked, getStudyAggregateChecked } from '@/lib/kv';
import { getHostedResearcherIdentity, getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { isHostedMode } from '@/lib/mode';
import {
  inspectOwnedStudyGates,
  loadAllowedInterviews,
  mapCollectionLoad,
} from '@/lib/ownedStudies';
import JSZip from 'jszip';
import { csvCell } from '@/lib/csv';
import { StoredInterview, StoredAggregateSynthesis } from '@/types';
import { logRequestFailure } from '@/lib/requestLog';
import type { RedisPort } from '@/lib/redisPort';

// Generate markdown transcript for an interview
function generateTranscript(interview: StoredInterview): string {
  const lines = [
    `# Interview Transcript`,
    `Study: ${interview.studyName}`,
    `Interview ID: ${interview.id}`,
    `Date: ${new Date(interview.createdAt).toLocaleDateString()}`,
    `Duration: ${Math.round((interview.completedAt - interview.createdAt) / 1000 / 60)} minutes`,
    ``
  ];

  // Add participant profile summary
  if (interview.participantProfile && interview.participantProfile.fields.length > 0) {
    lines.push(`## Participant Profile`);
    interview.participantProfile.fields.forEach(f => {
      const value = f.status === 'extracted' ? f.value : `(${f.status})`;
      lines.push(`- **${f.fieldId}**: ${value}`);
    });
    if (interview.participantProfile.rawContext) {
      lines.push(``);
      lines.push(`**Context**: ${interview.participantProfile.rawContext}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Conversation`);
  lines.push(``);

  interview.transcript.forEach(msg => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const role = msg.role === 'user' ? 'PARTICIPANT' : 'INTERVIEWER';
    lines.push(`[${time}] ${role}:`);
    lines.push(msg.content);
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

async function loadStudyAggregates(
  interviews: StoredInterview[],
  kvClient: RedisPort,
): Promise<Map<string, StoredAggregateSynthesis> | 'unavailable'> {
  const aggregates = new Map<string, StoredAggregateSynthesis>();
  for (const studyId of new Set(interviews.map(interview => interview.studyId))) {
    const loaded = await getStudyAggregateChecked(studyId, kvClient);
    if (loaded.status === 'unavailable') return 'unavailable';
    if (loaded.status === 'found') aggregates.set(studyId, loaded.aggregate);
  }
  return aggregates;
}

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

  interviews.forEach((interview, index) => {
    const paddedIndex = String(index + 1).padStart(3, '0');
    const date = new Date(interview.createdAt).toISOString().split('T')[0];
    const baseName = `${paddedIndex}_${date}_${interview.id.slice(0, 8)}`;
    zip.file(`${baseName}.json`, JSON.stringify(interview, null, 2));
    zip.file(`${baseName}.md`, generateTranscript(interview));
  });

  for (const [studyId, aggregate] of aggregates) {
    zip.file(`aggregates/${studyId}.json`, JSON.stringify(aggregate, null, 2));
  }

  const csvLines = [
    'Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight',
  ];
  interviews.forEach((interview) => {
    const duration = Math.round((interview.completedAt - interview.createdAt) / 1000 / 60);
    const themes = interview.synthesis?.themes.length || 0;
    const insight = interview.synthesis?.bottomLine || '';
    csvLines.push(
      `${csvCell(interview.id)},${csvCell(interview.studyName)},${csvCell(new Date(interview.createdAt).toISOString())},${duration},${interview.transcript.length},${themes},${csvCell(insight)}`,
    );
  });
  zip.file('summary.csv', csvLines.join('\n'));

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return new Response(zipBlob, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=interviews-export-${Date.now()}.zip`,
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
          tooLarge: 'This export is too large for an interactive download. Export a smaller study set.',
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
      const loaded = await loadAllowedInterviews(inspection.allowedIds, access.context.kvClient, 500);
      const mapped = mapCollectionLoad(loaded, {
        unavailable: 'Interview storage is temporarily unavailable.',
        tooLarge: 'This export is too large for an interactive download. Export a smaller study set.',
      });
      if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
      if (mapped.items.length === 0) {
        if (inspection.pendingStudies.length > 0) return pendingExportResponse();
        return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
      }
      const hostedAggregates = await loadStudyAggregates(mapped.items, access.context.kvClient);
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
    const loaded = await getAllInterviewsChecked(context.kvClient, 500);
    const mapped = mapCollectionLoad(loaded, {
      unavailable: 'Interview storage is temporarily unavailable.',
      tooLarge: 'This export is too large for an interactive download. Export a smaller study set.',
    });
    if (!mapped.ok) return NextResponse.json(mapped.body, { status: mapped.status });
    if (mapped.items.length === 0) {
      return NextResponse.json({ error: 'No interviews to export' }, { status: 404 });
    }
    const standaloneAggregates = await loadStudyAggregates(mapped.items, context.kvClient);
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
