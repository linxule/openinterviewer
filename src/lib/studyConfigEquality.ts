import type { StudyConfig } from '@/types';

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]));
  }
  return value;
}

/** Compare structural content, retaining optional fields' protocol meaning. */
export function studyConfigEqual(current: StudyConfig, next: StudyConfig): boolean {
  const normalize = (config: StudyConfig) => ordered({
    ...config,
    linksEnabled: config.linksEnabled ?? true,
  });
  return JSON.stringify(normalize(current)) === JSON.stringify(normalize(next));
}

export const studyConfigsEqual = studyConfigEqual;
