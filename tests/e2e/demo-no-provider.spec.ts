import { expect, test } from '@playwright/test';

test('public demo closes the research loop without API or external requests', async ({ page }) => {
  const appOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || '3100'}`;
  const apiRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === appOrigin && url.pathname.startsWith('/api/')) {
      apiRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (url.protocol.startsWith('http') && url.origin !== appOrigin) {
      externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
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
  await expect(page.getByText(/forgotten which project it was for/i)).toBeVisible();

  await page.getByRole('button', { name: /trace this insight in the transcript/i }).click();
  await expect(page.getByTestId('demo-evidence-turn')).toHaveClass(/ring-2/);

  await page.reload();
  await expect(page.getByTestId('demo-start')).toBeVisible();
  expect(apiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});
