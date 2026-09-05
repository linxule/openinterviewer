const ID_PREFIXES = ['session-', 'interview-']

/**
 * Display-only. Saved interview ids are `session-<uuid>`; the seeded sample
 * workspace uses `interview-demo-<name>`. Either prefix is identical across
 * rows, so strip it and show the part a researcher can distinguish rows by.
 * A short remainder (the sample workspace's `demo-sarah`) is shown whole.
 */
export function shortInterviewId(id: string): string {
  const prefix = ID_PREFIXES.find((candidate) => id.startsWith(candidate))
  const body = prefix ? id.slice(prefix.length) : id
  return body.length <= 12 ? body : body.slice(0, 8)
}
