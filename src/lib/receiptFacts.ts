/**
 * Facts for the participant's submission receipt (DIRECTION §7 "Receipt").
 * Display-only, derived from the tab's own transcript and the server-issued
 * consent timestamp already in the store. Nothing here is authority; the
 * durable record is the saved interview.
 */

/** Turns the participant contributed. `system` messages are not turns. */
export function participantTurnCount(transcript: ReadonlyArray<{ role: string }>): number {
  return transcript.filter((message) => message.role === 'user').length
}

/**
 * Milliseconds from the first to the last message. Null when the transcript
 * cannot span an interval (fewer than two messages) or a timestamp is not a
 * usable number — the caller omits the row rather than printing a guess.
 */
export function transcriptElapsedMs(transcript: ReadonlyArray<{ timestamp: number }>): number | null {
  if (transcript.length < 2) return null
  const first = transcript[0].timestamp
  const last = transcript[transcript.length - 1].timestamp
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  const elapsed = last - first
  return elapsed >= 0 ? elapsed : null
}

/** `m:ss`, or `h:mm:ss` past an hour. Never "0 min" for a short interview. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * `2026-09-05 14:32 UTC` from the server-issued epoch-millisecond consent
 * timestamp. UTC and not a locale format: this line exists so the participant
 * can compare what they see against the record the researcher holds, and a
 * locale-rendered local time is not the value that was stored. Null for any
 * value the consent API could not have issued (`api/consent/route.ts:100`
 * returns `recorded.consent.acceptedAt`, validated as a positive safe integer
 * at `participantConsent.ts:70–72`).
 */
export function formatConsentTimestamp(acceptedAt: number | null): string | null {
  if (acceptedAt === null || !Number.isSafeInteger(acceptedAt) || acceptedAt <= 0) return null
  return `${new Date(acceptedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
