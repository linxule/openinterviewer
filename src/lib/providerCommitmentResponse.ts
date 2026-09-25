import { NextResponse } from 'next/server';

/** Researcher routes: an interview whose consent named another provider or model. */
export function researcherProviderNotDisclosedResponse(extra?: HeadersInit): NextResponse {
  return NextResponse.json(
    {
      code: 'PROVIDER_NOT_DISCLOSED',
      error: 'This interview\'s participant was told their responses go only to the AI provider and model the study used when they took part. Set the study back to that provider and model to analyze it.',
    },
    { status: 409, ...(extra ? { headers: extra } : {}) },
  );
}
