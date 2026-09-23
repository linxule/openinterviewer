import { expect, test } from '@playwright/test';

test.describe('Cloudflare artifact smoke (RT-03, RT-06)', () => {
  test('public pages render and protected pages require sign-in', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenInterviewer/i);
    await page.goto('/demo');
    await expect(page.locator('main')).toBeVisible();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard/);
  });

  test('researcher signs in through the real session cookie path', async ({ page, request }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('e2e-cloudflare-admin-password');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(/\/studies$/);
    await expect(page.getByRole('heading', { name: 'My Studies', level: 1 })).toBeVisible();
    const state = await (await request.get('/__fixture/state')).json();
    expect(state.refused).toEqual([]);
  });
});
