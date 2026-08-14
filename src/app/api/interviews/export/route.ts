// GET /api/interviews/export - Export all interviews as ZIP
// Protected: Requires authenticated session

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getAllInterviewsChecked } from '@/lib/kv';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import JSZip from 'jszip';
import { csvCell } from '@/lib/csv';
import { StoredInterview } from '@/types';

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
        lines.push(`- ${t.theme}: ${t.evidence}`);
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

export async function GET() {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const loaded = await getAllInterviewsChecked(context.kvClient, 500);
    if (loaded.status === 'unavailable') {
      return NextResponse.json(
        { error: 'Interview storage is temporarily unavailable.', retryable: true },
        { status: 503 }
      );
    }
    if (loaded.status === 'too-large') {
      return NextResponse.json(
        { error: 'This export is too large for an interactive download. Export a smaller study set.' },
        { status: 413 }
      );
    }
    const interviews = loaded.items;

    if (interviews.length === 0) {
      return NextResponse.json(
        { error: 'No interviews to export' },
        { status: 404 }
      );
    }

    // Create ZIP file
    const zip = new JSZip();

    // Add each interview as JSON and markdown
    interviews.forEach((interview, index) => {
      const paddedIndex = String(index + 1).padStart(3, '0');
      const date = new Date(interview.createdAt).toISOString().split('T')[0];
      const baseName = `${paddedIndex}_${date}_${interview.id.slice(0, 8)}`;

      // JSON version
      zip.file(`${baseName}.json`, JSON.stringify(interview, null, 2));

      // Markdown transcript
      zip.file(`${baseName}.md`, generateTranscript(interview));
    });

    // Add summary CSV (formula-safe cells)
    const csvLines = [
      'Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight'
    ];
    interviews.forEach(interview => {
      const duration = Math.round((interview.completedAt - interview.createdAt) / 1000 / 60);
      const themes = interview.synthesis?.themes.length || 0;
      const insight = interview.synthesis?.bottomLine || '';
      csvLines.push(
        `${csvCell(interview.id)},${csvCell(interview.studyName)},${csvCell(new Date(interview.createdAt).toISOString())},${duration},${interview.transcript.length},${themes},${csvCell(insight)}`
      );
    });
    zip.file('summary.csv', csvLines.join('\n'));

    // Generate ZIP as blob
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Return as download
    return new Response(zipBlob, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename=interviews-export-${Date.now()}.zip`
      }
    });
  } catch (error) {
    console.error('Export API error:', error);
    return NextResponse.json(
      { error: 'Failed to export interviews' },
      { status: 503 }
    );
  }
}
