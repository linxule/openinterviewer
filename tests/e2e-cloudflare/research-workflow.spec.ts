// Cloudflare production-artifact research journey (VERIFY-03, UI-CF-05,
// JOB-01/04/09, ST-08). Real handlers, real WorkspaceStore SQLite, real alarm
// dispatch and a real local Queue consumer; only provider HTTP is synthetic.
import JSZip from 'jszip';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { ANSWER, GREETING, INSIGHT } from './fixtureData.mjs';

const ADMIN_PASSWORD = 'e2e-cloudflare-admin-password';

type FixtureState = { calls: Array<{ operation: string; model: string }>; refused: string[] };

async function fixtureState(request: APIRequestContext): Promise<FixtureState> {
  return (await request.get('/__fixture/state')).json();
}

async function count(request: APIRequestContext, operation: string): Promise<number> {
  return (await fixtureState(request)).calls.filter((call) => call.operation === operation).length;
}

async function control(request: APIRequestContext, action: string): Promise<void> {
  const response = await request.post(`/__fixture/${action}`);
  expect(response.ok()).toBe(true);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
}

async function createStudy(page: Page): Promise<string> {
  await signIn(page);
  await page.goto('/setup');
  await page.getByLabel('Study Name *', { exact: true }).fill('Cloudflare workflow study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  return page.url();
}

async function participantCompletes(browser: Browser, linkPath: string): Promise<Page> {
  const context = await browser.newContext();
  const participant = await context.newPage();
  await participant.goto(linkPath);
  await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
  await participant.getByLabel('Your response').fill(ANSWER);
  await participant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(participant.getByRole('heading', { name: /conversation complete/ })).toBeVisible();
  return participant;
}

async function saveAndClose(participant: Page): Promise<void> {
  await participant.getByRole('button', { name: 'Continue to save interview' }).click();
  await expect(participant.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(participant.getByText('Your responses have been saved. It is now safe to close this tab.')).toBeVisible();
  await participant.context().close();
}

test.beforeEach(async ({ request }) => {
  await control(request, 'reset');
});

test('participant saves before analysis runs; background analysis completes after the tab closes; researcher recovers a failure once, exports and aggregates', async ({ page, browser, request }, testInfo) => {
  const studyUrl = await createStudy(page);
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]{43}$/);
  const participantLink = await linkInput.inputValue();
  expect(new URL(participantLink).origin).toBe('https://workflow.example.test');
  const linkPath = new URL(participantLink).pathname;

  // JOB-01: the save response never waits on synthesis. Hold every synthesis
  // request, complete and save, and close the tab while the analysis is held.
  await control(request, 'hold-synthesis');
  const first = await participantCompletes(browser, linkPath);
  await saveAndClose(first);
  // The alarm dispatches and the Queue consumer calls the provider in the
  // background, with no participant or researcher request in flight.
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  await control(request, 'release-synthesis');

  // Participant two: the provider rejects synthesis (a known failure).
  await control(request, 'fail-next-synthesis');
  const second = await participantCompletes(browser, linkPath);
  await saveAndClose(second);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(2);

  await page.goto(studyUrl);
  await expect(page.getByText(/^2 interviews/)).toBeVisible();
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(page.getByRole('button', { name: /View interview \d/ })).toHaveCount(2);
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Find the failed interview (the second save) and the completed one.
  const detailUrls: string[] = [];
  for (const name of ['View interview 1', 'View interview 2']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/interview\//);
    detailUrls.push(page.url());
    await page.goto(studyUrl);
    await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  }

  let failedUrl = '';
  for (const url of detailUrls) {
    await page.goto(url);
    await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
    const failed = page.getByText('Analysis failed', { exact: true });
    const insight = page.getByText(INSIGHT, { exact: true }).first();
    await expect(failed.or(insight)).toBeVisible({ timeout: 60_000 });
    if (await failed.isVisible()) failedUrl = url;
  }
  expect(failedUrl).not.toBe('');

  // UI-CF-05 / JOB-04: two researcher tabs press "Run analysis" on the same
  // failed interview. One generation runs; exactly one more provider request.
  const before = await count(request, 'synthesis');
  const second_tab = await page.context().newPage();
  await Promise.all([page.goto(failedUrl), second_tab.goto(failedUrl)]);
  for (const tab of [page, second_tab]) await tab.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await Promise.all([page, second_tab].map((tab) => tab.getByRole('button', { name: 'Run analysis', exact: true }).click()));
  for (const tab of [page, second_tab]) {
    await expect(tab.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  }
  await second_tab.close();
  expect(await count(request, 'synthesis')).toBe(before + 1);
  await expect(page.getByText(/^Conducted by/)).toContainText('Synthesized by');
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloudflare-analysis-complete-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Aggregate synthesis over both analyzed interviews, persisted.
  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze All Interviews', exact: true }).click();
  await expect(page.getByText('Context notes help both participants resume work.', { exact: true })).toBeVisible();
  await expect(page.getByText(/· saved /)).toBeVisible();

  // ST-08 / RT-09: the streamed researcher export is a complete archive.
  const exported = await page.request.get('/api/interviews/export');
  expect(exported.status()).toBe(200);
  expect(exported.headers()['cache-control']).toContain('no-store');
  const zip = await JSZip.loadAsync(await exported.body());
  const names = Object.keys(zip.files);
  expect(names.filter((name) => /^\d{3}_.*\.json$/.test(name))).toHaveLength(2);
  expect(names.some((name) => name.startsWith('aggregates/') && name.endsWith('.json'))).toBe(true);
  const summary = await zip.file('summary.csv')!.async('string');
  expect(summary.split('\n').filter(Boolean).length).toBe(3);

  // Provider accounting and egress: no Redis, no unexpected destination.
  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(state.calls.filter((call) => call.operation === 'greeting')).toHaveLength(2);
  expect(state.calls.filter((call) => call.operation === 'interview')).toHaveLength(2);
  expect(state.calls.filter((call) => call.operation === 'synthesis')).toHaveLength(3);
  expect(state.calls.filter((call) => call.operation === 'aggregate')).toHaveLength(1);
});

test('researcher preview never creates research records or jobs', async ({ page, request }) => {
  const studyUrl = await createStudy(page);
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(page.getByText(GREETING, { exact: true })).toBeVisible();
  await page.getByLabel('Your response').fill(ANSWER);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: /conversation complete/ })).toBeVisible();
  await page.getByRole('button', { name: 'Continue preview', exact: true }).click();
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible();
  await page.goto(studyUrl);
  await expect(page.getByText('0 interviews', { exact: true })).toBeVisible();
  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(state.calls.filter((call) => call.operation === 'synthesis')).toHaveLength(1);
});
