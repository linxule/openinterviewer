// POST /api/interviews/save - Save completed interview
// Validates participant token or admin session for security
// Server-side validation ensures data integrity

import { NextResponse } from 'next/server';
import { saveInterview, isKVAvailable, incrementStudyInterviewCount, lockStudy } from '@/lib/kv';
import { verifyParticipantToken } from '@/lib/auth';
import { StoredInterview } from '@/types';

export async function POST(request: Request) {
  try {
    // Verify participant token or admin session (for researcher preview)
    const auth = await verifyParticipantToken(request);
    if (!auth.valid) {
      return NextResponse.json(
        { error: 'Valid participant token or admin session required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const clientData = body as Partial<StoredInterview>;

    // Validate studyId matches the token's studyId (skip for admin sessions)
    if (!auth.isAdmin && auth.studyId && clientData.studyId && auth.studyId !== clientData.studyId) {
      return NextResponse.json(
        { error: 'Study ID mismatch - token is for a different study' },
        { status: 403 }
      );
    }

    // Validate required fields exist
    if (!clientData.id || !clientData.studyId || !clientData.transcript) {
      return NextResponse.json(
        { error: 'Missing required fields: id, studyId, transcript' },
        { status: 400 }
      );
    }

    // Validate transcript is a non-empty array
    if (!Array.isArray(clientData.transcript) || clientData.transcript.length === 0) {
      return NextResponse.json(
        { error: 'Invalid transcript: must be a non-empty array' },
        { status: 400 }
      );
    }

    // Validate studyId format (alphanumeric with hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(clientData.studyId)) {
      return NextResponse.json(
        { error: 'Invalid studyId format' },
        { status: 400 }
      );
    }

    // Validate id format
    if (!/^[a-zA-Z0-9-]+$/.test(clientData.id)) {
      return NextResponse.json(
        { error: 'Invalid interview id format' },
        { status: 400 }
      );
    }

    // Build the interview with server-controlled fields
    const now = Date.now();
    const defaultProfile = {
      id: clientData.id,
      fields: [],
      rawContext: '',
      timestamp: now
    };
    const interview: StoredInterview = {
      id: clientData.id,
      studyId: clientData.studyId,
      studyName: clientData.studyName || 'Unknown Study',
      participantProfile: clientData.participantProfile || defaultProfile,
      transcript: clientData.transcript,
      synthesis: clientData.synthesis || null,
      behaviorData: clientData.behaviorData || {
        timePerTopic: {},
        messagesPerTopic: {},
        topicsExplored: [],
        contradictions: []
      },
      // Server-controlled timestamps - don't trust client-provided values
      createdAt: clientData.createdAt && clientData.createdAt < now
        ? clientData.createdAt  // Accept if in the past (reasonable)
        : now,
      completedAt: now,  // Always server-generated
      status: 'completed'  // Always set by server
    };

    // Check if KV is available
    const kvAvailable = await isKVAvailable();
    if (!kvAvailable) {
      // Return success but with warning
      console.warn('KV not available. Interview not persisted.');
      return NextResponse.json({
        success: false,
        id: interview.id,
        warning: 'Storage not configured. Interview not persisted.'
      });
    }

    // Save the interview
    const success = await saveInterview(interview);

    if (!success) {
      return NextResponse.json(
        { error: 'Failed to save interview' },
        { status: 500 }
      );
    }

    // Update study metadata (increment count and lock if first interview)
    // These operations are non-critical - don't fail the request if they fail
    try {
      await incrementStudyInterviewCount(interview.studyId);
      await lockStudy(interview.studyId);
    } catch (studyUpdateError) {
      // Log but don't fail - study may not exist in KV (legacy/token-only studies)
      console.warn('Failed to update study metadata:', studyUpdateError);
    }

    return NextResponse.json({ success: true, id: interview.id });
  } catch (error) {
    console.error('Save interview API error:', error);
    return NextResponse.json(
      { error: 'Failed to save interview' },
      { status: 500 }
    );
  }
}
