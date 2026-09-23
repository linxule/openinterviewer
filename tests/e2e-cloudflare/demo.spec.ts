// VERIFY-03 fixture lifecycle on the Cloudflare production artifact: the
// public demo stays fully keyless. The same interaction as
// tests/e2e/demo-no-provider.spec.ts, asserted in the browser and again at the
// fixture proxy, which sees every request the browser sends to the Worker and
// every outbound request the Worker makes.
import { expect, test } from '@playwright/test';
import { control, fixtureState } from './journey';

test('public demo runs keyless: no /api request from the browser or at the Worker, and no outbound request', async ({ page, request, baseURL }) => {
  await control(request, 'reset');
  const appOrigin = new URL(baseURL!).origin;
  const apiRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (url.origin === appOrigin && url.pathname.startsWith('/api/')) apiRequests.push(`${sent.method()} ${url.pathname}`);
    if (url.protocol.startsWith('http') && url.origin !== appOrigin) externalRequests.push(`${sent.method()} ${url.origin}${url.pathname}`);
  });

  await page.goto('/demo');
  await expect(page.getByText(/scripted demo/i).first()).toBeVisible();
  await expect(page.getByText(/maya is fictional/i)).toBeVisible();
  await page.getByTestId('demo-start').click();

  await expect(page.getByTestId('demo-progress')).toContainText('Question 1 of 3');
  await page.getByTestId('demo-choice-project').click();
  await expect(page.getByText(/saved it for a specific future use/i)).toBeVisible();
  await page.getByTestId('demo-choice-project-context-lost').click();
  await expect(page.getByText(/reason for saving had faded/i)).toBeVisible();
  await page.getByTestId('demo-choice-project-own-note').click();

  await expect(page.getByTestId('demo-message-ai')).toHaveCount(4);
  await expect(page.getByTestId('demo-progress')).toContainText('Interview complete');
  await page.getByTestId('demo-view-insight').click();

  await expect(page.getByRole('heading', { name: /illustrative synthesis/i })).toBeVisible();
  await expect(page.getByTestId('demo-insight-disclosure')).toContainText('No model analyzed Maya');
  await expect(page.getByText(/lost context creates re-entry work/i)).toBeVisible();
  await page.getByRole('button', { name: /trace this insight in the transcript/i }).click();
  await expect(page.getByTestId('demo-evidence-turn')).toHaveClass(/ring-2/);

  await page.reload();
  await expect(page.getByTestId('demo-start')).toBeVisible();

  expect(apiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
  const state = await fixtureState(request);
  expect(state.inbound).toEqual([]);
  expect(state.calls).toEqual([]);
  expect(state.refused).toEqual([]);

  // Positive control: the proxy does record an /api request when one is made.
  expect((await request.get('/api/health/ready')).status()).toBe(200);
  expect((await fixtureState(request)).inbound).toEqual(['GET /api/health/ready']);
});
