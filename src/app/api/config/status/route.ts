// GET /api/config/status - Returns which optional API keys are configured
// Only returns boolean status, never actual key values

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';

export async function GET() {
  try {
    // Require admin session - only researchers need this info
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

    if (!sessionToken || !(await verifySessionToken(sessionToken))) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Check which keys are configured (server-side check)
    const status = {
      // Claude provider support
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,

      // Gemini provider support
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
    };

    return NextResponse.json(status);
  } catch (error) {
    console.error('Config status API error:', error);
    return NextResponse.json(
      { error: 'Failed to check configuration status' },
      { status: 500 }
    );
  }
}
