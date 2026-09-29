/** A saved preview returns to its own document; /setup alone creates a study. */
export function previewSetupDestination(studyId: string | null | undefined): string {
  return studyId ? `/setup?prefill=edit&studyId=${encodeURIComponent(studyId)}` : '/setup';
}
