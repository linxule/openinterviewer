/**
 * Which analysis protocol this deployment speaks (RT-08, UI-CF-03). Read once
 * per page load from the public readiness endpoint:
 *
 * - `queued-v2`: durable analysis; versioned POST plus read-only status polling.
 * - `synchronous`: the legacy Node path. Also the answer when the field is
 *   absent (older deployments) or null (the server could not resolve its
 *   capabilities).
 * - `unknown`: the readiness answer could not be read. Callers must treat it
 *   like `synchronous` for starting analysis and must never poll. An unversioned
 *   request is safe against either backend: a durable server refuses it with
 *   ANALYSIS_CLIENT_UPDATE_REQUIRED before any work, and a Node server runs its
 *   existing path. Cloudflare-only status reads are never sent on a guess.
 *
 * Only a confirmed answer is cached; `unknown` is asked again on next use.
 */
export type AnalysisExecutionMode = 'synchronous' | 'queued-v2' | 'unknown';

const READINESS_TIMEOUT_MS = 5_000;

let confirmed: AnalysisExecutionMode | null = null;
let inFlight: Promise<AnalysisExecutionMode> | null = null;

export function parseAnalysisExecution(data: unknown): AnalysisExecutionMode {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unknown';
  const value = (data as Record<string, unknown>).analysisExecution;
  if (value === 'queued-v2') return 'queued-v2';
  if (value === undefined || value === null || value === 'synchronous') return 'synchronous';
  return 'unknown';
}

async function readAnalysisExecution(): Promise<AnalysisExecutionMode> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await fetch('/api/config/readiness', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return 'unknown';
    return parseAnalysisExecution(await response.json());
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export function loadAnalysisExecution(): Promise<AnalysisExecutionMode> {
  if (confirmed) return Promise.resolve(confirmed);
  if (!inFlight) {
    inFlight = readAnalysisExecution().then((mode) => {
      inFlight = null;
      if (mode !== 'unknown') confirmed = mode;
      return mode;
    });
  }
  return inFlight;
}
