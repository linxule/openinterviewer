import { test, expect, ANSWER, GREETING } from './workflow-fixture';
import { projectsJourney, projectAssignmentFailureJourney } from './projects-journey';
import type { Page } from '@playwright/test';
async function signIn(page: Page) {
  await page.goto('/login'); await page.getByLabel('Password').fill('synthetic-e2e-admin-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click(); await expect(page).toHaveURL(/\/studies$/);
}
test('standalone projects preserve participant authority and stream checked transcripts', async ({ page, workflow }) => {
  await signIn(page);
  await projectsJourney(page, {
    providerCount: async () => workflow.calls.length,
    settled: async interviews => { await expect.poll(() => workflow.calls.filter(call => call.operation === 'synthesis').length).toBe(interviews); },
    completeParticipant: async link => {
      const context = await workflow.participantContext(); const participant = await context.newPage();
      await participant.goto(link); await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
      await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
      await participant.getByLabel('Your response').fill(ANSWER); await participant.getByRole('button', { name: 'Send', exact: true }).click();
      await participant.getByRole('button', { name: 'Continue to save interview' }).click();
      await expect(participant.getByText('Your responses have been saved. It is now safe to close this tab.')).toBeVisible(); await context.close();
    },
  });
  expect(workflow.unexpected).toEqual([]);
});
test('assignment failure leaves exactly one saved ungrouped study', async ({ page, workflow }) => {
  await signIn(page); await projectAssignmentFailureJourney(page); expect(workflow.calls).toHaveLength(0);
});
