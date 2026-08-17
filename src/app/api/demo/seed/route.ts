// Authenticated sample-workspace fixture. This is separate from the public,
// in-memory /demo and writes synthetic records to the researcher's Upstash DB.
// Protected: requires an authenticated researcher session.

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getRequestContext } from '@/lib/researcherContext';
import { configurationRequiredResponse } from '@/lib/researcherAccess';
import { saveStudy, saveInterview, isKVAvailable, getAllStudies } from '@/lib/kv';
import { DEMO_STUDIES, DEMO_INTERVIEWS } from '@/lib/demoData';
import { DEFAULT_MODEL_BY_PROVIDER } from '@/lib/providerRegistry';
import {
  isGatewayAuthConfigured,
  isGatewayProvider,
  resolveAITransport,
} from '@/lib/aiTransport';
import { isHostedMode } from '@/lib/mode';
import { logRequestFailure } from '@/lib/requestLog';

export async function POST() {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured. Connect Upstash Redis before loading sample workspace data.' },
        { status: 503 }
      );
    }

    // Historical records keep their demo-prefixed IDs for compatibility.
    const existingStudies = await getAllStudies(context.kvClient);
    const demoExists = existingStudies.some(s => s.id.startsWith('demo-'));
    if (demoExists) {
      return NextResponse.json(
        { error: 'Sample workspace data is already loaded. Clear it before reloading.' },
        { status: 409 }
      );
    }

    const configuredGatewayProvider = process.env.AI_PROVIDER?.trim() || 'gemini';
    const aiProvider = !isHostedMode()
      && resolveAITransport() === 'gateway'
      && isGatewayAuthConfigured()
      && isGatewayProvider(configuredGatewayProvider)
      ? configuredGatewayProvider
      : context.geminiApiKey?.trim()
        ? 'gemini'
        : context.anthropicApiKey?.trim()
          ? 'claude'
          : context.openaiApiKey?.trim()
            ? 'openai'
            : context.openrouterApiKey?.trim()
              ? 'openrouter'
              : null;
    if (!aiProvider) {
      return NextResponse.json(
        { error: 'AI provider not configured. Configure the active AI transport before loading sample workspace data.' },
        { status: 503 }
      );
    }

    // Never mutate the process-wide fixtures. A warm function may serve
    // researchers with different provider configurations in sequence.
    const studiesToSeed = structuredClone(DEMO_STUDIES);
    const interviewsToSeed = structuredClone(DEMO_INTERVIEWS);
    for (const study of studiesToSeed) {
      study.config.aiProvider = aiProvider;
      study.config.aiModel = DEFAULT_MODEL_BY_PROVIDER[aiProvider];
      if (aiProvider !== 'gemini') {
        // The legacy reasoning toggle is a Gemini-only study option.
        delete study.config.enableReasoning;
      }
    }

    // Seed studies
    let studiesSeeded = 0;
    for (const study of studiesToSeed) {
      const success = await saveStudy(study, context.kvClient);
      if (success) studiesSeeded++;
    }

    // Seed interviews
    let interviewsSeeded = 0;
    for (const interview of interviewsToSeed) {
      const success = await saveInterview(interview, context.kvClient);
      if (success) interviewsSeeded++;
    }

    return NextResponse.json({
      success: true,
      message: 'Sample workspace data loaded successfully',
      data: {
        studiesSeeded,
        interviewsSeeded,
        aggregateSynthesisAvailable:
          studiesSeeded === studiesToSeed.length && interviewsSeeded >= 2
      }
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/demo/seed',
      method: 'POST',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to seed sample workspace data' },
      { status: 500 }
    );
  }
}

// Clear the authenticated sample-workspace fixture.
export async function DELETE() {
  try {
    const access = await getRequestContext();
    const setupResponse = configurationRequiredResponse(access);
    if (setupResponse) return setupResponse;
    const { authorized, context, error } = access;
    if (!authorized || !context) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const kvAvailable = await isKVAvailable(context.kvClient);
    if (!kvAvailable) {
      return NextResponse.json(
        { error: 'Storage not configured.' },
        { status: 503 }
      );
    }

    // Use the researcher's KV client directly for cleanup operations
    const kv = context.kvClient;

    // Delete sample studies
    let studiesDeleted = 0;
    for (const study of DEMO_STUDIES) {
      await kv.del(`study:${study.id}`);
      await kv.srem('all-studies', study.id);
      studiesDeleted++;
    }

    // Delete sample interviews
    let interviewsDeleted = 0;
    for (const interview of DEMO_INTERVIEWS) {
      await kv.del(`interview:${interview.id}`);
      await kv.srem(`study-interviews:${interview.studyId}`, interview.id);
      await kv.srem('all-interviews', interview.id);
      interviewsDeleted++;
    }

    return NextResponse.json({
      success: true,
      message: 'Sample workspace data cleared',
      data: {
        studiesDeleted,
        interviewsDeleted
      }
    });
  } catch (error) {
    logRequestFailure({
      event: 'route.failure',
      route: '/api/demo/seed',
      method: 'DELETE',
      status: 500,
    }, error);
    return NextResponse.json(
      { error: 'Failed to clear sample workspace data' },
      { status: 500 }
    );
  }
}
