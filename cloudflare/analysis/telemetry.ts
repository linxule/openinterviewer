// Count-only `analysis.job` events for the scheduler, the Queue consumer and
// the job RPCs. Never carries identifiers, content, provider payloads or keys:
// only allowlisted enums, a provider name and an error type.

import { errorTypeOf, logRequestEvent, type RequestLogReason } from '../../src/lib/requestLog';

export type JobOperation =
  | 'alarm'
  | 'dispatch'
  | 'watchdog'
  | 'cleanup'
  | 'consume'
  | 'claim'
  | 'start'
  | 'execute'
  | 'finish'
  | 'retry'
  | 'status';

export function logJobEvent(event: {
  operation: JobOperation;
  reason?: RequestLogReason;
  provider?: string;
  transport?: 'direct' | 'cloudflare-gateway';
  error?: unknown;
  durationMs?: number;
}): void {
  logRequestEvent({
    event: 'analysis.job',
    operation: event.operation,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.transport ? { transport: event.transport } : {}),
    ...(event.error !== undefined ? { errorType: errorTypeOf(event.error) } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  });
}
