// A participant never sees an interview step on a route that is about to be
// replaced. Every navigation to /consent (a document load from the link page)
// and /interview (a client-router flight fetch from consent) is held back
// deliberately, so the window between the hand-over and the new page is wide
// on every run instead of only on a slow one.
import { expect, test, type Route } from '@playwright/test';
import { ANSWER, GREETING } from './fixtureData.mjs';
import { control, count, createStudy, fixtureState, generateLink } from './journey';

const HELD_ROUTES = new Set(['/consent', '/interview']);
const NAVIGATION_DELAY_MS = 2_500;
// Waits that span a held navigation get the delay on top of the usual margin;
// the default 5 s expect timeout would leave only half of it for real work.
const ACROSS_HELD_NAVIGATION = { timeout: NAVIGATION_DELAY_MS + 10_000 };

test.beforeEach(async ({ request }) => {
  await control(request, 'reset');
});

test('a delayed route change neither shows a step early nor discards a typed answer', async ({ browser, page, request }) => {
  await createStudy(page);
  const linkPath = await generateLink(page);

  const context = await browser.newContext();
  const participant = await context.newPage();
  const held: string[] = [];
  await participant.route(
    (url) => HELD_ROUTES.has(url.pathname),
    async (route: Route) => {
      const request = route.request();
      // The link page leaves by document navigation; consent by the client router.
      if (request.isNavigationRequest() || request.headers().rsc === '1') {
        held.push(`${request.isNavigationRequest() ? 'document' : 'flight'} ${new URL(request.url()).pathname}`);
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY_MS));
      }
      // The page may already be closed when a held request is released.
      await route.continue().catch(() => undefined);
    },
  );

  await participant.goto(linkPath);
  const consent = participant.getByRole('button', { name: 'I consent — begin the interview' });
  await expect(consent).toBeVisible(ACROSS_HELD_NAVIGATION);
  // Not a retrying assertion: with /consent held, a consent button can only be
  // visible here if the link page rendered one while the navigation was pending.
  expect(new URL(participant.url()).pathname).toBe('/consent');

  await consent.click();
  // Consent is recorded but /interview is still held: the button stays unavailable.
  await expect(participant.getByRole('button', { name: 'Opening the interview…' })).toBeDisabled();
  expect(new URL(participant.url()).pathname).toBe('/consent');
  await expect(participant.getByLabel('Your response')).toHaveCount(0);

  await expect(participant.getByText(GREETING, { exact: true })).toBeVisible(ACROSS_HELD_NAVIGATION);
  expect(new URL(participant.url()).pathname).toBe('/interview');

  const composer = participant.getByLabel('Your response');
  await composer.fill(ANSWER);
  await expect(composer).toHaveValue(ANSWER);
  await participant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(participant.getByRole('heading', { name: /conversation complete/ })).toBeVisible();

  expect(held).toEqual(expect.arrayContaining(['document /consent', 'flight /interview']));
  // One greeting and one consent record: no step was mounted twice.
  expect(await count(request, 'greeting')).toBe(1);
  expect((await fixtureState(request)).inbound.filter((line) => line === 'POST /api/consent')).toHaveLength(1);
  await participant.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
});

test('the link code never leaves the link page in a request header', async ({ browser, page }) => {
  await createStudy(page);
  const linkPath = await generateLink(page);
  const linkCode = linkPath.split('/').pop()!;

  const context = await browser.newContext();
  const participant = await context.newPage();
  const headers: Array<Promise<{ url: string; headers: Record<string, string> }>> = [];
  participant.on('request', (request) => {
    headers.push(request.allHeaders().then((all) => ({ url: new URL(request.url()).pathname, headers: all })));
  });
  const linkDocument = participant.waitForResponse((response) => new URL(response.url()).pathname === linkPath);

  await participant.goto(linkPath);
  const referrerPolicy = (await linkDocument).headers()['referrer-policy'];
  await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();

  const seen = await Promise.all(headers);
  // The link exchange itself carries the code in its query (the one place it must).
  expect(seen.some((entry) => entry.url === '/api/generate-link')).toBe(true);
  const leaks = seen.flatMap((entry) => Object.entries(entry.headers)
    .filter(([, value]) => value.includes(linkCode))
    .map(([name]) => `${entry.url} ${name}`));
  expect(leaks).toEqual([]);
  expect(seen.filter((entry) => 'next-url' in entry.headers).map((entry) => `${entry.url} ${entry.headers['next-url']}`))
    .not.toContainEqual(expect.stringContaining('/p/'));
  expect(referrerPolicy).toBe('no-referrer');
  await context.close();
});

test('leaving preview removes the old screen before clearing its session and awaiting setup', async ({ page, request }) => {
  await createStudy(page);
  await page.goto('/setup');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(page.getByText(GREETING, { exact: true })).toBeVisible();
  await page.getByLabel('Your response').fill('Unsubmitted preview draft');

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/setup', async (route) => {
    if (route.request().headers().rsc === '1') await hold;
    await route.continue().catch(() => undefined);
  });
  await page.getByRole('button', { name: 'Exit Preview' }).click();
  await expect(page.getByRole('status')).toHaveText('Returning to study setup…');
  expect(new URL(page.url()).pathname).toBe('/interview');
  await expect(page.getByLabel('Your response')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  expect(await count(request, 'greeting')).toBe(1);

  release();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('status').filter({ hasText: 'Returning to study setup' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled();
  expect((await fixtureState(request)).refused).toEqual([]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
