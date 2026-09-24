// Participant sessions where the browser cannot keep them in sessionStorage
// (issue #52), on the Node target. The Cloudflare lane has the same checks
// (tests/e2e-cloudflare/participant-navigation.spec.ts).
import type { BrowserContext, Page, Request } from '@playwright/test';
import { test, expect, GREETING } from './workflow-fixture';

type StorageMode = 'available' | 'unavailable' | 'full';

async function createStudyLink(page: Page): Promise<string> {
  await page.goto('/login');
  await page.getByLabel('Password').fill('synthetic-e2e-admin-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
  await page.goto('/setup');
  await page.getByLabel('Study Name *', { exact: true }).fill('Synthetic session study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
  return new URL(await linkInput.inputValue()).pathname;
}

/** `unavailable`: DOM storage disabled. `full`: every write exceeds the quota. */
async function withStorage(context: BrowserContext, mode: StorageMode): Promise<void> {
  if (mode === 'unavailable') {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      });
    });
  } else if (mode === 'full') {
    await context.addInitScript(() => {
      Storage.prototype.setItem = function setItem() {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    });
  }
}

const isFlight = (request: Request) => request.headers().rsc === '1';

for (const mode of ['available', 'unavailable', 'full'] as const) {
  test(`with sessionStorage ${mode}, a link reaches the interview and its code never leaves the link page in a request header`, async ({ page, workflow }) => {
    const linkPath = await createStudyLink(page);
    const linkCode = linkPath.split('/').pop()!;
    const context = await workflow.participantContext();
    await withStorage(context, mode);
    const participant = await context.newPage();
    const requests: Array<Promise<{ path: string; flight: boolean; document: boolean; headers: Record<string, string> }>> = [];
    participant.on('request', (request) => {
      requests.push(request.allHeaders().then((headers) => ({
        path: new URL(request.url()).pathname,
        flight: isFlight(request),
        document: request.isNavigationRequest(),
        headers,
      })));
    });

    await participant.goto(linkPath);
    await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
    await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
    expect(new URL(participant.url()).pathname).toBe('/interview');

    const seen = await Promise.all(requests);
    // Storage that keeps the session: a document load of /consent. Otherwise
    // the client router keeps it in memory, from the code-free /p route state.
    const handover = seen.filter((entry) => entry.path === '/consent' && (entry.flight || entry.document));
    expect(handover.some((entry) => (mode === 'available' ? entry.document : entry.flight))).toBe(true);
    expect(seen.some((entry) => entry.path === '/api/generate-link')).toBe(true);
    const leaks = seen.flatMap((entry) => Object.entries(entry.headers)
      .filter(([, value]) => value.includes(linkCode))
      .map(([name]) => `${entry.path} ${name}`));
    expect(leaks).toEqual([]);
  });
}

test('a memory-only session lost to a failed Flight navigation says how to recover, and reopening the link does', async ({ page, workflow }) => {
  const linkPath = await createStudyLink(page);
  const context = await workflow.participantContext();
  await withStorage(context, 'unavailable');
  const participant = await context.newPage();
  // Next.js turns a failed Flight response into a document navigation, which
  // discards a session held only in memory.
  const consentRoute = (url: URL) => url.pathname === '/consent';
  await participant.route(consentRoute, async (route) => {
    if (isFlight(route.request())) await route.fulfill({ status: 500, body: 'synthetic failure' });
    else await route.continue();
  });

  await participant.goto(linkPath);
  await expect(participant.getByRole('heading', { name: 'This interview is not open in this tab' })).toBeVisible();
  expect(new URL(participant.url()).pathname).toBe('/consent');
  await expect(participant.getByText(/open the link you were given again/)).toBeVisible();
  await expect(participant.getByRole('button', { name: 'I consent — begin the interview' })).toHaveCount(0);

  await participant.unroute(consentRoute);
  await participant.goto(linkPath);
  await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
});
