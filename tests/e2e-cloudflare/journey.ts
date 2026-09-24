// Shared steps for the Cloudflare production-artifact browser specs: the
// synthetic fixture controls in server.mjs and the researcher/participant
// journey through the real UI.
import { expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { ANSWER, GREETING } from './fixtureData.mjs';

export const ADMIN_PASSWORD = 'e2e-cloudflare-admin-password';
// Researcher copy from src/components/analysis/InterviewAnalysisPanel.tsx.
export const PROVIDER_FAILURE_COPY = 'The model provider did not return an analysis. This is not an analysis — run it again.';
export const RECOVERY_COPY =
  'This interview is saved, but we could not confirm the analysis result. Running it again may make another paid provider request.';
export const RUNNING_COPY = 'This interview is saved. Analysis is in progress.';

/** One researcher analysis request as the fixture proxy saw it (server.mjs). */
export type AnalyzeExchange = {
  method: 'GET' | 'POST';
  interviewId: string;
  idempotencyKey: string | null;
  request: { expectedGeneration?: number } | null;
  status: number;
  reply: { status?: string; generation?: number; phase?: string } | null;
  replyLost: boolean;
  /** The start was answered by the proxy and never reached the Worker. */
  dropped?: boolean;
};

export type FixtureState = {
  calls: Array<{ operation: string; model: string; status: number }>;
  refused: string[];
  pendingSynthesisFailures: number;
  heldSynthesis: number;
  inbound: string[];
  analyze: AnalyzeExchange[];
};

export async function fixtureState(request: APIRequestContext): Promise<FixtureState> {
  return (await request.get('/__fixture/state')).json();
}

export async function count(request: APIRequestContext, operation: string): Promise<number> {
  return (await fixtureState(request)).calls.filter((call) => call.operation === operation).length;
}

export async function control(request: APIRequestContext, action: string): Promise<void> {
  const response = await request.post(`/__fixture/${action}`);
  expect(response.ok()).toBe(true);
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
}

export async function createStudy(page: Page): Promise<{ studyUrl: string; studyId: string }> {
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

export async function generateLink(page: Page): Promise<string> {
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]{43}$/);
  const participantLink = await linkInput.inputValue();
  expect(new URL(participantLink).origin).toBe('https://workflow.example.test');
  return new URL(participantLink).pathname;
}

export async function participantCompletes(browser: Browser, linkPath: string): Promise<Page> {
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

export async function saveAndClose(participant: Page): Promise<void> {
  await participant.getByRole('button', { name: 'Continue to save interview' }).click();
  await expect(participant.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(participant.getByText('Your responses have been saved. It is now safe to close this tab.')).toBeVisible();
  await participant.context().close();
}

/** Opens participant `number`'s interview from the study table on its Analysis tab; returns its URL. */
export async function openInterviewAnalysis(page: Page, studyUrl: string, number: number): Promise<string> {
  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await page.getByRole('button', { name: `View interview ${number}`, exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/interview\/[^/?]+\?studyId=/);
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  return page.url();
}

/** The interview id in an interview detail URL. */
export function interviewIdOf(detailUrl: string): string {
  return new URL(detailUrl).pathname.split('/').pop()!;
}

/** The researcher analysis status read (API-02) for one interview, through the browser's own session cookie. */
export async function readStatusOf(
  page: Page,
  studyId: string,
  interviewId: string,
): Promise<{ status: number; cacheControl: string | null; body: string }> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.text() };
  }, `/api/interviews/${encodeURIComponent(interviewId)}/analyze?studyId=${encodeURIComponent(studyId)}`);
}

/** The analysis status read for the interview whose detail page is open. */
export async function readAnalysisStatus(page: Page): Promise<{ status: number; cacheControl: string | null; body: string }> {
  const detail = new URL(page.url());
  return readStatusOf(page, detail.searchParams.get('studyId')!, interviewIdOf(page.url()));
}

export function isAnalyzePost(url: string, method: string): boolean {
  return method === 'POST' && /\/api\/interviews\/[^/]+\/analyze$/.test(new URL(url).pathname);
}

/** Moves keyboard focus with `key` alone until `target` holds it. */
export async function pressUntilFocused(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<void> {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < 60; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

/** Keyboard focus is visible on `target`: the token focus ring from globals.css. */
export async function expectFocusRing(target: Locator): Promise<void> {
  expect(await target.evaluate((element) => (
    element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'
  ))).toBe(true);
}
