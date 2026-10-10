import { test, expect } from '@playwright/test';
import { control, count, fixtureState, participantCompletes, saveAndClose, signIn } from './journey';
import { projectsJourney, projectAssignmentFailureJourney } from '../e2e/projects-journey';
test.beforeEach(async ({ request }) => { await control(request, 'reset'); });
test('artifact projects preserve participant authority and stream checked transcripts', async ({ page, browser, request }) => {
  await signIn(page);
  await projectsJourney(page, {
    providerCount: async () => (await fixtureState(request)).calls.length,
    settled: async interviews => { await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(interviews); },
    completeParticipant: async link => { await saveAndClose(await participantCompletes(browser, link)); },
  });
  expect((await fixtureState(request)).refused).toEqual([]);
});
test('artifact assignment failure preserves the saved study without another create', async ({ page, request }) => {
  await signIn(page); await projectAssignmentFailureJourney(page); expect((await fixtureState(request)).calls).toHaveLength(0);
});
