import { expect, test } from '@playwright/test';

test('public demo is deterministic and makes no API requests', async ({ page }) => {
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

  await expect(page.getByText(/sample simulation/i)).toBeVisible();
  await expect(page.getByText(/do not enter personal or confidential information/i)).toBeVisible();
  await page.getByTestId('demo-start').click();

  const input = page.getByTestId('demo-chat-input');
  await expect(input).toBeEnabled();
  await input.fill('I want to understand how an AI interview feels.');
  await input.press('Enter');

  await expect(page.getByTestId('demo-message-ai')).toHaveCount(2);
  await expect(input).toBeEnabled();
  expect(apiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});
