// Cloudflare production-artifact analysis controls (VERIFY-03 concurrent
// retries, UI-CF-04/05, JOB-04, API-01/03/04, IMPLEMENTATION F8). Real
// handlers, real WorkspaceStore SQLite, real alarm dispatch and a real local
// Queue consumer; only provider HTTP is synthetic, and the fixture proxy
// records every researcher analysis request with the action key it carried.
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import { AGGREGATE, INSIGHT } from './fixtureData.mjs';
import {
  PROVIDER_FAILURE_COPY,
  RECOVERY_COPY,
  RUNNING_COPY,
  control,
  count,
  createStudy,
  expectFocusRing,
  fixtureState,
  generateLink,
  interviewIdOf,
  isAnalyzePost,
  openInterviewAnalysis,
  participantCompletes,
  pressUntilFocused,
  readStatusOf,
  saveAndClose,
  type AnalyzeExchange,
  type FixtureState,
} from './journey';

// Researcher copy from src/components/analysis/InterviewAnalysisPanel.tsx,
// src/components/StudyDetail.tsx and src/services/analysisApi.ts.
const QUEUED_COPY = 'This interview is saved. Its analysis will run in the background.';
const SCHEDULED_ONE = 'Analysis queued or running for 1 interview. It finishes in the background and is not part of the batch.';
const BATCH_RECOVERY_DISCLOSURE =
  '1 interview in this batch is saved, but we could not confirm its earlier analysis result. Running the batch analyzes it again, which may make another paid provider request.';
const START_UNAVAILABLE = 'Analysis is temporarily unavailable. Please try again.';
const HELD_START_COPY = 'Analysis is paused while this workspace is under maintenance. Nothing was started; try again later.';
const UNCONFIRMED_START_COPY =
  'The request may still have been accepted. Check the status before running it again. Running it again repeats this request rather than starting another.';
const AGGREGATE_NEEDS_TWO = 'Need at least 2 analyzed interviews to generate aggregate analysis.';
const OPERATOR_TOKEN = 'e2e-cloudflare-operator-token-00000000000001';
const POLL_AFTER_MS = 2000;
const ANALYZE_PATH = /^\/api\/interviews\/[^/]+\/analyze$/;
const AGGREGATE_PATH = /^\/api\/synthesis\/aggregate$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Matches text that contains `literal`. */
function containing(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function synthesisStatuses(state: FixtureState): number[] {
  return state.calls.filter((call) => call.operation === 'synthesis').map((call) => call.status);
}

function startsFor(state: FixtureState, interviewId: string): AnalyzeExchange[] {
  return state.analyze.filter((exchange) => exchange.method === 'POST' && exchange.interviewId === interviewId);
}

function readsFor(exchanges: AnalyzeExchange[], interviewId: string): AnalyzeExchange[] {
  return exchanges.filter((exchange) => exchange.method === 'GET' && exchange.interviewId === interviewId);
}

async function statusBody(page: Page, studyId: string, interviewId: string): Promise<unknown> {
  const read = await readStatusOf(page, studyId, interviewId);
  expect(read.status).toBe(200);
  return JSON.parse(read.body);
}

/** Waits until the open pages have polled `interviewId` at least `reads` more times. */
async function waitForPolls(page: Page, request: APIRequestContext, interviewId: string, reads: number): Promise<void> {
  const mark = (await fixtureState(request)).analyze.length;
  await expect.poll(
    async () => readsFor((await fixtureState(request)).analyze.slice(mark), interviewId).length,
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(reads);
}

function registerRow(page: Page, participantNumber: number): Locator {
  return page.getByRole('row').filter({
    has: page.getByRole('button', { name: `View interview ${participantNumber}`, exact: true }),
  });
}

/**
 * A disabled control's reason is the text a screen reader reaches next: in the
 * accessibility tree, the run of text nodes directly after the control, before
 * any other control or structure.
 */
async function expectReasonFollows(scope: Locator, control: string, reason: string): Promise<void> {
  const lines = (await scope.ariaSnapshot()).split('\n').map((line) => line.trim());
  const at = lines.indexOf(`- ${control}`);
  expect(at, `${control} in\n${lines.join('\n')}`).toBeGreaterThanOrEqual(0);
  const following: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^- (paragraph|status|alert|text|note)\b/.test(line)) break;
    following.push(line);
  }
  expect(following.join('\n')).toContain(reason);
}

/** Keyboard only: focus the selected tab, arrow to `target`, activate it with `key`. */
async function selectTabByKeyboard(page: Page, from: string, target: string, arrow: 'ArrowRight' | 'ArrowLeft', key: 'Enter' | 'Space'): Promise<void> {
  const selected = page.getByRole('tab', { name: from, exact: true });
  const next = page.getByRole('tab', { name: target, exact: true });
  await pressUntilFocused(page, selected, arrow === 'ArrowLeft' ? 'Shift+Tab' : 'Tab');
  await expectFocusRing(selected);
  await page.keyboard.press(arrow);
  await expect(next).toBeFocused();
  await page.keyboard.press(key);
  await expect(next).toHaveAttribute('aria-selected', 'true');
}

/**
 * Holds the page's matching requests in the browser until released, so a
 * transient in-flight state can be observed; they then reach the real
 * backend unchanged.
 */
async function holdInBrowser(page: Page, method: 'GET' | 'POST', path: RegExp): Promise<{ release: () => void; dispose: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const matches = (url: URL) => path.test(url.pathname);
  const handler = async (route: Route) => {
    if (route.request().method() === method) await released;
    await route.continue();
  };
  await page.route(matches, handler);
  return { release, dispose: () => page.unroute(matches, handler) };
}

function answered(page: Page, method: 'GET' | 'POST', path: RegExp) {
  return page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname));
}

/** OPS-01 operator maintenance transition through the researcher's own fresh session. */
async function setMaintenance(page: Page, next: 'open' | 'draining'): Promise<void> {
  const call = (method: 'GET' | 'POST', path: string, body?: object) => page.evaluate(
    async ({ method, path, body, token }) => {
      const response = await fetch(path, {
        method,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    },
    { method, path, body, token: OPERATOR_TOKEN },
  );
  const status = await call('GET', '/api/operator/status');
  expect(status.status).toBe(200);
  const { state, version } = status.body.maintenance as { state: string; version: number };
  if (state === next) return;
  const moved = await call('POST', '/api/operator/maintenance', { expectedState: state, expectedVersion: version, nextState: next });
  expect(moved.status).toBe(200);
  expect(moved.body).toMatchObject({ status: 'transitioned', state: next });
}

test.beforeEach(async ({ request }) => {
  await control(request, 'reset');
});

test('detail and batch retries race the automatic job: one active generation each, the batch only observes active work, polling never pays', async ({ page, browser, request }) => {
  const { studyUrl, studyId } = await createStudy(page);
  const linkPath = await generateLink(page);

  // Participant 1's automatic job fails with a known provider failure.
  await control(request, 'fail-next-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  const failedUrl = await openInterviewAnalysis(page, studyUrl, 1);
  await expect(page.getByText('Analysis failed', { exact: true })).toBeVisible({ timeout: 60_000 });
  const failedId = interviewIdOf(failedUrl);

  // Participant 2's automatic job reaches the provider and is held there.
  await control(request, 'hold-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(2);
  const activeId = interviewIdOf(await openInterviewAnalysis(page, studyUrl, 2));
  await expect(page.getByText(RUNNING_COPY, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Run analysis/ })).toHaveCount(0);
  const automatic = { status: 'pending', generation: 1, phase: 'running', pollAfterMs: POLL_AFTER_MS };
  expect(await statusBody(page, studyId, activeId)).toEqual(automatic);

  // Tab A, the study register. F8: the active automatic job is counted, never batched.
  await page.goto(studyUrl);
  await expect(page.getByText('2 interviews · 2 awaiting analysis', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(registerRow(page, 1)).toContainText('analysis failed');
  await expect(registerRow(page, 2)).toContainText('analysis running');
  await expect(page.getByText(SCHEDULED_ONE, { exact: true })).toBeVisible();
  const batch = page.getByRole('button', { name: 'Analyze 1 pending', exact: true });
  await expect(batch).toBeEnabled();

  // Tab B, participant 1's detail, offering the retry.
  const detail = await page.context().newPage();
  await detail.goto(failedUrl);
  await detail.getByRole('tab', { name: 'Analysis', exact: true }).click();
  const run = detail.getByRole('button', { name: 'Run analysis', exact: true });
  await expect(run).toBeEnabled();

  // Both actions at once: two intentional actions (one per tab), two keys, one expected generation.
  const sentBy = [page, detail].map((tab) => tab.waitForRequest((sent) => isAnalyzePost(sent.url(), sent.method())));
  await Promise.all([batch.click(), run.click()]);
  const tabKeys = await Promise.all(sentBy.map(async (sent) => (await sent).headers()['idempotency-key']));
  for (const key of tabKeys) expect(key).toMatch(UUID_V4);
  expect(tabKeys[0]).not.toBe(tabKeys[1]);
  await expect.poll(async () => (await fixtureState(request)).analyze.filter((exchange) => exchange.method === 'POST').length).toBe(2);
  const starts = startsFor(await fixtureState(request), failedId);
  expect(starts).toHaveLength(2);
  for (const start of starts) {
    expect(start).toMatchObject({
      request: { expectedGeneration: 1 },
      status: 202,
      reply: { status: 'pending', generation: 2 },
      replyLost: false,
    });
  }
  expect(starts.map((start) => start.idempotencyKey).sort()).toEqual([...tabKeys].sort());

  // One active generation per interview (JOB-04). The consumer takes one
  // delivery at a time (max_concurrency 1), so retry generation 2 waits queued
  // behind the held automatic job: the provider has still seen two requests.
  expect(await statusBody(page, studyId, failedId)).toEqual({ status: 'pending', generation: 2, phase: 'queued', pollAfterMs: POLL_AFTER_MS });
  expect(await statusBody(page, studyId, activeId)).toEqual(automatic);

  // Both tabs poll generation 2; a poll only reads (API-02/03).
  await waitForPolls(page, request, failedId, 4);
  const polled = await fixtureState(request);
  expect(synthesisStatuses(polled)).toEqual([400, 200]);
  expect(polled.heldSynthesis).toBe(1);
  expect(polled.analyze.filter((exchange) => exchange.method === 'POST')).toHaveLength(2);
  expect(startsFor(polled, activeId)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Analyzing 0 of 1…', exact: true })).toBeDisabled();
  await expect(page.getByText('Analyzing 1 interview.', { exact: true })).toBeVisible();
  await expect(detail.getByText(QUEUED_COPY, { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: /^Run analysis/ })).toHaveCount(0);

  // Release: the automatic job finishes, then generation 2 runs once.
  await control(request, 'release-synthesis');
  await expect(detail.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Batch complete: 1 of 1 finished.', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => statusBody(page, studyId, activeId), { timeout: 60_000 }).toEqual({ status: 'complete', generation: 1 });
  expect(await statusBody(page, studyId, failedId)).toEqual({ status: 'complete', generation: 2 });
  await detail.close();

  await page.reload();
  await expect(page.getByText('2 interviews', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(registerRow(page, 1)).toContainText('analyzed');
  await expect(registerRow(page, 2)).toContainText('analyzed');
  await expect(page.getByRole('button', { name: /^Analyze \d+ pending$/ })).toHaveCount(0);
  await expect(page.getByText(/^Analysis queued or running/)).toHaveCount(0);

  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(synthesisStatuses(state)).toEqual([400, 200, 200]);
  expect(state.analyze.filter((exchange) => exchange.method === 'POST')).toHaveLength(2);
  expect(state.inbound.filter((line) => line.startsWith('POST ') && ANALYZE_PATH.test(line.slice('POST '.length)))).toHaveLength(2);
});

test('the detail analysis controls work from the keyboard alone; a start refused while the workspace is held says why and repeats its own key', async ({ page, browser, request }) => {
  const { studyUrl, studyId } = await createStudy(page);
  const linkPath = await generateLink(page);
  // Participant 1: a provider 5xx after start (recovery required). Participant 2: a known failure.
  await control(request, 'server-error-next-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  await control(request, 'fail-next-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(2);
  const recoveryUrl = await openInterviewAnalysis(page, studyUrl, 1);
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const failedUrl = await openInterviewAnalysis(page, studyUrl, 2);
  await expect(page.getByText(PROVIDER_FAILURE_COPY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const recoveryId = interviewIdOf(recoveryUrl);
  const failedId = interviewIdOf(failedUrl);
  const analysisTab = page.getByRole('tab', { name: 'Analysis', exact: true });

  // Retry after recovery, keyboard only: Tab, arrow, Space.
  await page.goto(recoveryUrl);
  await selectTabByKeyboard(page, 'Transcript', 'Analysis', 'ArrowRight', 'Space');
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toBeVisible();
  const runAgain = page.getByRole('button', { name: 'Run analysis again', exact: true });
  await pressUntilFocused(page, runAgain);
  await expectFocusRing(runAgain);
  await control(request, 'hold-synthesis');
  const startHold = await holdInBrowser(page, 'POST', ANALYZE_PATH);
  await page.keyboard.press('Space');
  // Disabled while the start is in flight; its name says why.
  await expect(page.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled();
  const accepted = answered(page, 'POST', ANALYZE_PATH);
  startHold.release();
  expect((await accepted).status()).toBe(202);
  await startHold.dispose();
  expect(startsFor(await fixtureState(request), recoveryId)).toMatchObject([
    { request: { expectedGeneration: 1 }, status: 202, reply: { status: 'pending', generation: 2 } },
  ]);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(3);
  await expect(page.getByText(RUNNING_COPY, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Run analysis/ })).toHaveCount(0);

  // UI-CF-05: polling and the completed refresh leave keyboard focus where the researcher put it.
  await pressUntilFocused(page, analysisTab, 'Shift+Tab');
  await waitForPolls(page, request, recoveryId, 2);
  await expect(analysisTab).toBeFocused();
  expect(await count(request, 'synthesis')).toBe(3);
  await control(request, 'release-synthesis');
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(analysisTab).toBeFocused();

  // Run analysis, keyboard only (Enter), while an operator holds the workspace (OPS-01 draining).
  await page.goto(failedUrl);
  await selectTabByKeyboard(page, 'Transcript', 'Analysis', 'ArrowRight', 'Enter');
  const run = page.getByRole('button', { name: 'Run analysis', exact: true });
  await pressUntilFocused(page, run);
  await expectFocusRing(run);
  await setMaintenance(page, 'draining');
  try {
    await page.keyboard.press('Enter');
    // The page cannot know about the hold before asking: the action stays
    // enabled, and the certain refusal (a 503 naming the maintenance hold) is
    // explained as such. Nothing was started or paid.
    const refusal = page.getByRole('alert').filter({ hasText: 'Analysis request failed' });
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(HELD_START_COPY);
    await expect(page.getByRole('alert').filter({ hasText: 'Analysis request not confirmed' })).toHaveCount(0);
    await expect(run).toBeEnabled();
    expect(startsFor(await fixtureState(request), failedId)).toMatchObject([
      { request: { expectedGeneration: 1 }, status: 503, replyLost: false, reply: { reason: 'maintenance' } },
    ]);
    expect(await count(request, 'synthesis')).toBe(3);
  } finally {
    await setMaintenance(page, 'open');
  }

  // After the hold lifts, a start whose outcome the page cannot know (the
  // request is dropped before the Worker) is uncertain: the alert offers a
  // read-only Check status, driven by keyboard only; it is disabled while the
  // read is in flight and its name says why.
  await control(request, 'fail-next-synthesis');
  await control(request, 'drop-next-analyze-request');
  await pressUntilFocused(page, run);
  await page.keyboard.press('Enter');
  const unconfirmed = page.getByRole('alert').filter({ hasText: 'Analysis request not confirmed' });
  await expect(unconfirmed).toBeVisible();
  await expect(unconfirmed).toContainText(START_UNAVAILABLE);
  await expect(unconfirmed).toContainText(UNCONFIRMED_START_COPY);
  const checkStatus = page.getByRole('button', { name: 'Check status', exact: true });
  await pressUntilFocused(page, checkStatus, 'Shift+Tab');
  await expectFocusRing(checkStatus);
  const mark = (await fixtureState(request)).analyze.length;
  const readHold = await holdInBrowser(page, 'GET', ANALYZE_PATH);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  const read = answered(page, 'GET', ANALYZE_PATH);
  readHold.release();
  expect((await read).status()).toBe(200);
  await readHold.dispose();
  await expect(checkStatus).toBeEnabled();
  expect(readsFor((await fixtureState(request)).analyze.slice(mark), failedId)).toMatchObject([
    { status: 200, reply: { status: 'failed', generation: 1 } },
  ]);
  expect(await count(request, 'synthesis')).toBe(3);

  // Pressed again: the same action, key and body (API-03).
  await pressUntilFocused(page, run);
  await page.keyboard.press('Enter');
  await expect.poll(async () => startsFor(await fixtureState(request), failedId).length).toBe(3);
  const [refusedStart, droppedStart, repeated] = startsFor(await fixtureState(request), failedId);
  expect(refusedStart).toMatchObject({ status: 503, reply: { reason: 'maintenance' } });
  expect(droppedStart).toMatchObject({ request: { expectedGeneration: 1 }, status: 503, dropped: true });
  expect(repeated).toMatchObject({ request: { expectedGeneration: 1 }, status: 202, reply: { status: 'pending', generation: 2 } });
  expect(droppedStart.idempotencyKey).toMatch(UUID_V4);
  expect(repeated.idempotencyKey).toBe(droppedStart.idempotencyKey);
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(4);
  await expect(page.getByText('Analysis failed', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(PROVIDER_FAILURE_COPY, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Analysis request not confirmed' })).toHaveCount(0);
  // The next failure's action is reachable again in both directions.
  await pressUntilFocused(page, analysisTab, 'Shift+Tab');
  await pressUntilFocused(page, run);
  expect(await statusBody(page, studyId, failedId)).toEqual({ status: 'failed', generation: 2, failureKind: 'provider', recoveryRequired: false });

  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(synthesisStatuses(state)).toEqual([500, 400, 200, 400]);
  // The recovery retry, the held refusal, the dropped start and its repeat: no other start.
  expect(state.analyze.filter((exchange) => exchange.method === 'POST')).toHaveLength(4);
});

test('the batch works from the keyboard alone; its disabled states say why; a lost start acknowledgement repeats its own key', async ({ page, browser, request }) => {
  const { studyUrl, studyId } = await createStudy(page);
  const linkPath = await generateLink(page);
  await control(request, 'server-error-next-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(1);
  await control(request, 'fail-next-synthesis');
  await saveAndClose(await participantCompletes(browser, linkPath));
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(2);
  const recoveryId = interviewIdOf(await openInterviewAnalysis(page, studyUrl, 1));
  await expect(page.getByText(RECOVERY_COPY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const failedId = interviewIdOf(await openInterviewAnalysis(page, studyUrl, 2));
  await expect(page.getByText(PROVIDER_FAILURE_COPY, { exact: true })).toBeVisible({ timeout: 60_000 });

  // Overview: aggregate analysis is disabled with fewer than two analyzed
  // interviews, and the reason is the next thing a screen reader reaches.
  await page.goto(studyUrl);
  const aggregate = page.getByRole('button', { name: 'Analyze All Interviews', exact: true });
  await expect(aggregate).toBeDisabled();
  await expectReasonFollows(page.getByRole('tabpanel'), 'button "Analyze All Interviews" [disabled]', AGGREGATE_NEEDS_TWO);

  // Keyboard only to the batch; the paid-retry consequence is its description (UI-CF-04).
  await selectTabByKeyboard(page, 'Overview', 'Interviews', 'ArrowRight', 'Enter');
  const batch = page.getByRole('button', { name: 'Analyze 2 pending', exact: true });
  await pressUntilFocused(page, batch);
  await expectFocusRing(batch);
  await expect(batch).toHaveAccessibleDescription(containing(BATCH_RECOVERY_DISCLOSURE));

  // The Worker accepts the oldest interview's start, but its acknowledgement is lost on the way back.
  await control(request, 'hold-synthesis');
  await control(request, 'lose-next-analyze-reply');
  await page.keyboard.press('Enter');
  const stopped = page.getByRole('alert').filter({ hasText: 'Analysis batch stopped' });
  await expect(stopped).toBeVisible();
  await expect(stopped).toContainText(START_UNAVAILABLE);
  await expect(page.getByText('Batch stopped: 0 of 2 finished.', { exact: true })).toBeVisible();
  const [lost] = startsFor(await fixtureState(request), recoveryId);
  expect(lost).toMatchObject({ request: { expectedGeneration: 1 }, status: 202, reply: { status: 'pending', generation: 2 }, replyLost: true });
  await expect.poll(() => count(request, 'synthesis'), { timeout: 60_000 }).toBe(3);

  // Pressed again (Space): the same key and body replay generation 2 (API-01/03); nothing new is allocated or paid.
  await pressUntilFocused(page, batch);
  await page.keyboard.press('Space');
  await expect.poll(async () => startsFor(await fixtureState(request), recoveryId).length).toBe(2);
  const [, replayed] = startsFor(await fixtureState(request), recoveryId);
  expect(replayed).toMatchObject({ request: { expectedGeneration: 1 }, status: 202, reply: { status: 'pending', generation: 2 }, replyLost: false });
  expect(lost.idempotencyKey).toMatch(UUID_V4);
  expect(replayed.idempotencyKey).toBe(lost.idempotencyKey);
  await expect(stopped).toHaveCount(0);

  // Disabled while it observes that work; its name and the status after it say why.
  const observing = page.getByRole('button', { name: 'Analyzing 0 of 2…', exact: true });
  await expect(observing).toBeDisabled();
  await expectReasonFollows(page.getByRole('tabpanel'), 'button "Analyzing 0 of 2…" [disabled]', 'Analyzing 2 interviews.');
  await waitForPolls(page, request, recoveryId, 2);
  const polled = await fixtureState(request);
  expect(synthesisStatuses(polled)).toEqual([500, 400, 200]);
  expect(startsFor(polled, recoveryId)).toHaveLength(2);
  expect(startsFor(polled, failedId)).toEqual([]);

  // Released: the batch finishes the first interview, then starts and finishes the second.
  await control(request, 'release-synthesis');
  await expect(page.getByText('Batch complete: 2 of 2 finished.', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(await statusBody(page, studyId, recoveryId)).toEqual({ status: 'complete', generation: 2 });
  expect(await statusBody(page, studyId, failedId)).toEqual({ status: 'complete', generation: 2 });
  await expect(registerRow(page, 1)).toContainText('analyzed');
  await expect(registerRow(page, 2)).toContainText('analyzed');

  // With two analyzed interviews the aggregate action is enabled and keyboard operable.
  await selectTabByKeyboard(page, 'Interviews', 'Overview', 'ArrowLeft', 'Enter');
  await pressUntilFocused(page, aggregate);
  await expectFocusRing(aggregate);
  const aggregateHold = await holdInBrowser(page, 'POST', AGGREGATE_PATH);
  await page.keyboard.press('Enter');
  // Disabled while the aggregate request is in flight; its name says why.
  await expect(page.getByRole('button', { name: 'Analyzing...', exact: true })).toBeDisabled();
  const aggregated = answered(page, 'POST', AGGREGATE_PATH);
  aggregateHold.release();
  expect((await aggregated).status()).toBe(200);
  await aggregateHold.dispose();
  await expect(page.getByText(AGGREGATE.bottomLine, { exact: true })).toBeVisible({ timeout: 60_000 });

  const state = await fixtureState(request);
  expect(state.refused).toEqual([]);
  expect(synthesisStatuses(state)).toEqual([500, 400, 200, 200]);
  expect(state.calls.filter((call) => call.operation === 'aggregate')).toHaveLength(1);
  expect(startsFor(state, recoveryId)).toHaveLength(2);
  expect(startsFor(state, failedId)).toMatchObject([
    { request: { expectedGeneration: 1 }, status: 202, reply: { status: 'pending', generation: 2 }, replyLost: false },
  ]);
});
