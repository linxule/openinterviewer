// A participant never sees an interview step on a route that is about to be
// replaced. Every client navigation to /consent and /interview is held back
// deliberately, so the window between router.replace()/push() and the new page
// is wide on every run instead of only on a slow one.
import { expect, test, type Route } from '@playwright/test';
import { ANSWER, GREETING } from './fixtureData.mjs';
import { control, count, createStudy, fixtureState, generateLink } from './journey';

const HELD_ROUTES = new Set(['/consent', '/interview']);
const NAVIGATION_DELAY_MS = 2_500;

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
      const flight = route.request();
      // Only the client router's flight fetch; a document load is not delayed.
      if (flight.headers().rsc === '1') {
        held.push(new URL(flight.url()).pathname);
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY_MS));
      }
      await route.continue();
    },
  );

  await participant.goto(linkPath);
  const consent = participant.getByRole('button', { name: 'I consent — begin the interview' });
  await expect(consent).toBeVisible();
  // Not a retrying assertion: with /consent held, a consent button can only be
  // visible here if the link page rendered one while the route change was pending.
  expect(new URL(participant.url()).pathname).toBe('/consent');

  await consent.click();
  // Consent is recorded but /interview is still held: the button stays unavailable.
  await expect(participant.getByRole('button', { name: 'Opening the interview…' })).toBeDisabled();
  expect(new URL(participant.url()).pathname).toBe('/consent');
  await expect(participant.getByLabel('Your response')).toHaveCount(0);

  await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
  expect(new URL(participant.url()).pathname).toBe('/interview');

  const composer = participant.getByLabel('Your response');
  await composer.fill(ANSWER);
  await expect(composer).toHaveValue(ANSWER);
  await participant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(participant.getByRole('heading', { name: /conversation complete/ })).toBeVisible();

  expect(held).toEqual(expect.arrayContaining(['/consent', '/interview']));
  // One greeting and one consent record: no step was mounted twice.
  expect(await count(request, 'greeting')).toBe(1);
  expect((await fixtureState(request)).inbound.filter((line) => line === 'POST /api/consent')).toHaveLength(1);
  await context.close();
});
