import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { DEFAULT_OPENAI_MODEL } from '../../src/types';
import { test, expect, ANSWER, GREETING, INSIGHT, UNSAID } from './workflow-fixture';

async function createStudy(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('synthetic-e2e-admin-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
  await page.goto('/setup');
  await page.getByLabel('Study Name *', { exact: true }).fill('Synthetic workflow study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  return page.url();
}

async function completeConversation(page: Page) {
  await page.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(page.getByText(GREETING, { exact: true })).toBeVisible();
  await page.getByLabel('Your response').fill(ANSWER);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: /conversation complete/ })).toBeVisible();
}

async function downloadText(page: Page, name: string | RegExp) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}

test('researcher creates a study; participants finalize; researcher reads, downloads and synthesizes saved interviews', async ({ page, workflow }, testInfo) => {
  const studyUrl = await createStudy(page);
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
  const participantLink = await linkInput.inputValue();
  expect(new URL(participantLink).origin).toBe('https://workflow.example.test');

  for (let participantIndex = 0; participantIndex < 2; participantIndex += 1) {
    const context = await workflow.participantContext();
    const participant = await context.newPage();
    // The synthetic deployment's canonical HTTPS origin maps to our loopback
    // production server; preserve the generated opaque participant path.
    await participant.goto(new URL(participantLink).pathname);
    await completeConversation(participant);
    if (participantIndex === 0) workflow.failNextSynthesis = true;
    else workflow.interruptStorageAfterSynthesis = true;
    await participant.getByRole('button', { name: 'Continue to save interview' }).click();
    if (participantIndex === 0) {
      await expect(participant.getByRole('heading', { name: "We couldn't finalize your interview" })).toBeVisible();
      await expect(participant.getByRole('button', { name: /export|download/i })).toHaveCount(0);
      await participant.getByRole('button', { name: 'Retry finalization' }).click();
    } else {
      await expect(participant.getByRole('heading', { name: "We couldn't save your interview" })).toBeVisible();
      workflow.storageOffline = false;
      await participant.getByRole('button', { name: 'Retry save', exact: true }).click();
    }
    await expect(participant.getByRole('heading', { name: 'Interview submitted' })).toBeVisible();
    await expect(participant.getByText('Your responses have been saved. It is now safe to close this tab.')).toBeVisible();
    // Refresh is a realistic finalization retry: it must retain success without
    // creating a duplicate interview or invoking synthesis again.
    const synthesisCalls = workflow.calls.filter(call => call.operation === 'synthesis').length;
    await participant.reload();
    await expect(participant.getByRole('heading', { name: 'Interview submitted' })).toBeVisible();
    expect(workflow.calls.filter(call => call.operation === 'synthesis')).toHaveLength(synthesisCalls);
    await context.close();
  }

  await page.goto(studyUrl);
  await expect(page.getByText('2 interviews', { exact: true })).toBeVisible();
  // The researcher shell must not overflow a phone: three rail destinations plus
  // the brand and Log out once pushed the top bar past 375px.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(page.getByRole('button', { name: /View interview \d/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'View interview 1', exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  const transcript = await downloadText(page, 'Download transcript');
  expect(transcript).toContain(ANSWER);
  expect(transcript).toContain(GREETING);
  const interview = JSON.parse(await downloadText(page, 'Download JSON'));
  expect(interview.transcript.some((turn: { content: string }) => turn.content === ANSWER)).toBe(true);
  expect(interview.synthesis.bottomLine).toBe(INSIGHT);
  expect(interview.aiProvider).toBe('openai');
  const transport = testInfo.project.name.endsWith('gateway') ? 'gateway' : 'direct';
  // Synthesis now uses the study's own configured model — the same one the
  // interview turns used — never a separate fixed synthesis model.
  const studyModel = transport === 'gateway' ? `openai/${DEFAULT_OPENAI_MODEL}` : DEFAULT_OPENAI_MODEL;
  expect(interview.aiModel).toBe(studyModel);
  expect(interview.requestedAiModel).toBe(studyModel);
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible();

  await page.goto(studyUrl);
  await page.getByRole('button', { name: 'Analyze All Interviews', exact: true }).click();
  await expect(page.getByText('Context notes help both participants resume work.', { exact: true })).toBeVisible();
  await expect(page.getByText('Investigate when notes are written.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Divergent Views', exact: true })).toHaveCount(0);

  // Aggregate citations (Slice L): ANSWER's ref verifies (both synthetic
  // interviews share turn 2), UNSAID's never locates — the pair that proves
  // the whole chain end to end. Exactly one wine numeral must exist: the
  // absence of a trigger is the signal that UNSAID's ref did not verify.
  await expect(page.getByRole('button', { name: /^t\.\d+$/ })).toHaveCount(1);
  const citationTrigger = page.getByRole('button', { name: 't.2', exact: true });
  await expect(citationTrigger).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(page.getByText(/^P0\d · turn 2$/)).toBeVisible();
  const traceLink = page.getByRole('link', { name: /^Read in P0\d's transcript$/ });
  await expect(traceLink).toBeVisible();
  await expect(traceLink).toHaveAttribute('href', /turn=2/);
  await expect(page.getByText(UNSAID)).toBeVisible();

  await expect(page.getByText(/· saved /)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/not saved/);
  expect(await page.locator('body').innerText()).not.toMatch(/receipt (eyJ|unsigned)/);

  await traceLink.click();
  await expect(page).toHaveURL(/\/dashboard\/interview\/[^/?]+\?studyId=[^&]+&turn=2$/);
  const tracedTurn = page.locator('#turn-2');
  await expect(tracedTurn).toBeFocused();
  await expect(tracedTurn).toHaveClass(/trace-ring/);

  // The stored analysis survives a reload with no further provider call: the
  // whole point of persistence (slice-N-spec.md N14).
  await page.goto(studyUrl);
  await expect(page.getByText('Context notes help both participants resume work.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 't.2', exact: true })).toBeVisible();
  await expect(page.getByText(/· saved /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze All Interviews', exact: true })).toBeVisible();

  expect(workflow.calls.filter(call => call.operation === 'aggregate')).toHaveLength(1);
  expect(workflow.calls.filter(call => call.operation === 'synthesis')).toHaveLength(3);
  expect(workflow.calls.filter(call => call.operation === 'greeting')).toHaveLength(2);
  expect(workflow.calls.filter(call => call.operation === 'interview')).toHaveLength(2);
  expect(new Set(workflow.calls.map(call => call.transport))).toEqual(new Set([transport]));
});

test('researcher preview can export its transcript after synthesis fails without storing research records', async ({ page, workflow }, testInfo) => {
  const studyUrl = await createStudy(page);
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await completeConversation(page);
  workflow.failNextSynthesis = true;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Continue preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analysis Failed', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-recovery-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Export transcript', exact: true }).click();
  expect(await downloadText(page, /^Download Transcript/)).toContain(ANSWER);
  await page.goto(studyUrl);
  await expect(page.getByText('0 interviews', { exact: true })).toBeVisible();
});
