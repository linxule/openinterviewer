// Cloudflare production-artifact research journey (VERIFY-03, UI-CF-02/03/05,
// JOB-01/03/04/09, ST-08). Real handlers, real WorkspaceStore SQLite, real
// alarm dispatch and a real local Queue consumer; only provider HTTP is
// synthetic.
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { AGGREGATE, ANSWER, GREETING, INSIGHT } from './fixtureData.mjs';

const ADMIN_PASSWORD = 'e2e-cloudflare-admin-password';
// Researcher copy from src/components/analysis/InterviewAnalysisPanel.tsx.
const PROVIDER_FAILURE_COPY = 'The model provider did not return an analysis. This is not an analysis — run it again.';
const RECOVERY_COPY =
  'This interview is saved, but we could not confirm the analysis result. Running it again may make another paid provider request.';
const RUNNING_COPY = 'This interview is saved. Analysis is in progress.';

type FixtureState = {
  calls: Array<{ operation: string; model: string; status: number }>;
  refused: string[];
  pendingSynthesisFailures: number;
  heldSynthesis: number;
};

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

async function createStudy(page: Page): Promise<{ studyUrl: string; studyId: string }> {
  await signIn(page);
  await page.goto('/setup');
  await page.getByLabel('Study Name *', { exact: true }).fill('Cloudflare workflow study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  const studyUrl = page.url();
  return { studyUrl, studyId: new URL(studyUrl).pathname.split('/').pop()! };
}

async function generateLink(page: Page): Promise<string> {
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]{43}$/);
  const participantLink = await linkInput.inputValue();
  expect(new URL(participantLink).origin).toBe('https://workflow.example.test');
  return new URL(participantLink).pathname;
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

/** Opens participant `number`'s interview from the study table on its Analysis tab; returns its URL. */
async function openInterviewAnalysis(page: Page, studyUrl: string, number: number): Promise<string> {
  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await page.getByRole('button', { name: `View interview ${number}`, exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/interview\/[^/?]+\?studyId=/);
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  return page.url();
}

/** 375px layout: no horizontal page scroll. Restores the desktop viewport. */
async function expectNoHorizontalScrollAt375(page: Page, screenshotPath?: string): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
}

/** The researcher analysis status read (API-02), through the browser's own session cookie. */
async function readAnalysisStatus(page: Page): Promise<{ status: number; cacheControl: string | null; body: string }> {
  const detail = new URL(page.url());
  const interviewId = detail.pathname.split('/').pop()!;
  const studyId = detail.searchParams.get('studyId')!;
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.text() };
  }, `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`);
}

function isAnalyzePost(url: string, method: string): boolean {
  return method === 'POST' && /\/api\/interviews\/[^/]+\/analyze$/.test(new URL(url).pathname);
}

/**
 * Researcher "Export All" (ST-08/RT-09): the browser client downloads only an
 * archive it verified as complete. Playwright's own request context would not
 * carry the Secure session cookie to http://127.0.0.1, so the real UI path is
 * both the faithful and the working route.
 */
async function exportAll(page: Page): Promise<JSZip> {
  await page.goto('/dashboard');
  const button = page.getByRole('button', { name: 'Export All', exact: true });
  await expect(button).toBeEnabled();
  const exported = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/interviews/export');
  const downloaded = page.waitForEvent('download');
  await button.click();
  const response = await exported;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  await expect(page.getByText('The export did not complete. Try the export again.')).toHaveCount(0);
  return JSZip.loadAsync(await readFile(await download.path()));
}

test.beforeEach(async ({ request }) => {
  await control(request, 'reset');
});

test('participant saves before analysis runs; background analysis completes after the tab closes; researcher recovers a failure once, exports and aggregates', async ({ page, browser, request }, testInfo) => {
  const { studyUrl, studyId } = await createStudy(page);
  const linkPath = await generateLink(page);

  // JOB-01: the save response never waits on synthesis. Hold every synthesis
  // request, complete and save, and close the tab while the analysis is held.
  await control(request, 'hold-synthesis');
  const first = await participantCompletes(browser, linkPath);
  await saveAndClose(first);
  // The alarm dispatches and the Queue consumer calls the provider in the
  // background, with no participant or researcher request in flight. The
  // request is still held here, so the save cannot have waited for it.
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  expect((await fixtureState(request)).heldSynthesis).toBe(1);
  await control(request, 'release-synthesis');

  // Participant two: the provider rejects synthesis (a known failure).
  await control(request, 'fail-next-synthesis');
  const second = await participantCompletes(browser, linkPath);
  await saveAndClose(second);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(2);
  expect((await fixtureState(request)).pendingSynthesisFailures).toBe(0);

  await page.goto(studyUrl);
  await expect(page.getByText(/^2 interviews/)).toBeVisible();
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(page.getByRole('button', { name: /View interview \d/ })).toHaveCount(2);
  await expectNoHorizontalScrollAt375(page);

  // Participant 1 (held, then released after the tab closed) is analyzed.
  await openInterviewAnalysis(page, studyUrl, 1);
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Conducted by/)).toContainText('Synthesized by');

  // Participant 2 shows the recorded known failure with safe copy only.
  const failedUrl = await openInterviewAnalysis(page, studyUrl, 2);
  await expect(page.getByText('Analysis failed', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(PROVIDER_FAILURE_COPY, { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic rejection')).toHaveCount(0);

  // UI-CF-05 / JOB-04: two researcher tabs press "Run analysis" on the same
  // failed interview while the provider is held, so both requests meet the
  // active generation. One generation runs; exactly one more provider request.
  const before = await count(request, 'synthesis');
  await control(request, 'hold-synthesis');
  const secondTab = await page.context().newPage();
  const tabs = [page, secondTab];
  await secondTab.goto(failedUrl);
  await secondTab.getByRole('tab', { name: 'Analysis', exact: true }).click();
  for (const tab of tabs) await expect(tab.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled();
  const posts = tabs.map((tab) => tab.waitForResponse((response) => isAnalyzePost(response.url(), response.request().method())));
  await Promise.all(tabs.map((tab) => tab.getByRole('button', { name: 'Run analysis', exact: true }).click()));
  const accepted = await Promise.all(posts.map(async (post) => {
    const response = await post;
    return { status: response.status(), body: await response.json() as { status: string; generation: number } };
  }));
  for (const { status, body } of accepted) {
    expect(status).toBe(202);
    expect(body.status).toBe('pending');
  }
  expect(accepted[0].body.generation).toBe(2);
  expect(accepted[1].body.generation).toBe(accepted[0].body.generation);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(before + 1);
  for (const tab of tabs) {
    await expect(tab.getByText(RUNNING_COPY, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tab.getByRole('button', { name: /^Run analysis/ })).toHaveCount(0);
  }
  await control(request, 'release-synthesis');
  for (const tab of tabs) {
    await expect(tab.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  }
  await secondTab.close();
  expect(await count(request, 'synthesis')).toBe(before + 1);
  await expect(page.getByText(/^Conducted by/)).toContainText('Synthesized by');
  await expectNoHorizontalScrollAt375(page, testInfo.outputPath('cloudflare-analysis-complete-mobile.png'));

  // Aggregate synthesis over both analyzed interviews, persisted.
  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze All Interviews', exact: true }).click();
  await expect(page.getByText(AGGREGATE.bottomLine, { exact: true })).toBeVisible();
  await expect(page.getByText(/· saved /)).toBeVisible();
  await page.reload();
  await expect(page.getByText(AGGREGATE.bottomLine, { exact: true })).toBeVisible();
  await expect(page.getByText(/· saved /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze All Interviews', exact: true })).toBeVisible();

  // ST-08 / RT-09: the streamed researcher export is a complete archive.
  // Entries are filtered to this study so a retry in the same server stays exact.
  const zip = await exportAll(page);
  const records: Array<{ id: string; studyId: string; synthesis: { bottomLine: string } | null; analysis?: { status: string }; transcript: Array<{ content: string }> }> = [];
  for (const name of Object.keys(zip.files).filter((entry) => /^\d{3}_.*\.json$/.test(entry))) {
    const record = JSON.parse(await zip.file(name)!.async('string'));
    if (record.studyId === studyId) records.push(record);
  }
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.analysis?.status).toBe('complete');
    expect(record.synthesis?.bottomLine).toBe(INSIGHT);
    expect(record.transcript.some((message) => message.content === ANSWER)).toBe(true);
  }
  const aggregate = JSON.parse(await zip.file(`aggregates/${studyId}.json`)!.async('string'));
  expect(aggregate).toMatchObject({ studyId, interviewCount: 2, bottomLine: AGGREGATE.bottomLine });
  const summary = (await zip.file('summary.csv')!.async('string')).split('\n').filter(Boolean);
  expect(summary[0]).toBe('Interview ID,Study,Date,Duration (min),Messages,Themes,Key Insight,Analysis');
  for (const record of records) {
    // Every text cell is quoted (src/lib/csv.ts).
    const rows = summary.filter((line) => line.startsWith(`"${record.id}",`));
    expect(rows).toHaveLength(1);
    expect(rows[0].endsWith(`,"${INSIGHT}","complete"`)).toBe(true);
  }

  // Provider accounting and egress: no Redis, no unexpected destination.
  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(state.calls.filter((call) => call.operation === 'greeting')).toHaveLength(2);
  expect(state.calls.filter((call) => call.operation === 'interview')).toHaveLength(2);
  expect(state.calls.filter((call) => call.operation === 'synthesis')).toHaveLength(3);
  expect(state.calls.filter((call) => call.operation === 'aggregate')).toHaveLength(1);
});

test('a synthesis 5xx after start needs recovery; one explicit retry makes exactly one more provider request', async ({ page, browser, request }, testInfo) => {
  // JOB-03 (DEVIATIONS.md): HTTP 5xx after the request reached the provider is
  // an uncertain paid outcome, recorded as recovery-required, never retried
  // automatically (JOB-09: SDK retries are zero under the queued policy).
  const { studyUrl } = await createStudy(page);
  const linkPath = await generateLink(page);
  await control(request, 'server-error-next-synthesis');
  const participant = await participantCompletes(browser, linkPath);
  await saveAndClose(participant);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  const afterFailure = await fixtureState(request);
  expect(afterFailure.pendingSynthesisFailures).toBe(0);
  expect(afterFailure.calls.filter((call) => call.operation === 'synthesis').map((call) => call.status)).toEqual([500]);

  // UI-CF-02: the needs-recovery state with the paid-retry disclosure.
  await openInterviewAnalysis(page, studyUrl, 1);
  await expect(page.getByText('Analysis needs recovery', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run analysis again', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic server error')).toHaveCount(0);
  await expectNoHorizontalScrollAt375(page, testInfo.outputPath('cloudflare-analysis-recovery-mobile.png'));

  // API-02: the closed projection says failed/timeout/recoveryRequired and
  // passes no provider message through.
  const projected = await readAnalysisStatus(page);
  expect(projected.status).toBe(200);
  expect(projected.cacheControl).toContain('no-store');
  expect(JSON.parse(projected.body)).toEqual({ status: 'failed', generation: 1, failureKind: 'timeout', recoveryRequired: true });

  // The state survives a reload and nothing retried in the background.
  await page.reload();
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toBeVisible();
  expect(await count(request, 'synthesis')).toBe(1);

  // One intentional retry: one new generation, exactly one more provider request.
  const post = page.waitForResponse((response) => isAnalyzePost(response.url(), response.request().method()));
  await page.getByRole('button', { name: 'Run analysis again', exact: true }).click();
  const accepted = await post;
  expect(accepted.status()).toBe(202);
  expect(await accepted.json()).toMatchObject({ status: 'pending', generation: 2 });
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Conducted by/)).toContainText('Synthesized by');
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toHaveCount(0);

  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(state.calls.filter((call) => call.operation === 'synthesis').map((call) => call.status)).toEqual([500, 200]);
  expect(state.calls.filter((call) => call.operation === 'greeting')).toHaveLength(1);
  expect(state.calls.filter((call) => call.operation === 'interview')).toHaveLength(1);
});

test('researcher preview never creates research records or jobs', async ({ page, request }) => {
  const { studyUrl } = await createStudy(page);
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
