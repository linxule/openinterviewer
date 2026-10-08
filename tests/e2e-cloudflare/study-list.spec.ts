// The study list deletes a study without interviews with a bodyless DELETE
// (the historic empty-only operation). On Workers, OpenNext hands the route
// an empty body stream rather than a null body; the route must treat it as
// no body, not as an invalid confirmation.
import { expect, test } from '@playwright/test';
import { control, createStudy } from './journey';

test.beforeEach(async ({ request }) => {
  await control(request, 'reset');
});

test('a study without interviews is deleted from the study list', async ({ page }) => {
  // The artifact's store outlives a test: a unique name finds this study's row.
  const name = `List delete study ${Date.now()}`;
  const { studyId } = await createStudy(page, name);
  await page.goto('/studies');
  await expect(page.getByRole('button', { name: `Open actions for ${name}` })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  const deleted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/studies/${studyId}` && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: `Open actions for ${name}` }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deleted).status()).toBe(200);
  await expect(page.getByRole('button', { name: `Open actions for ${name}` })).toHaveCount(0);
  const status = await page.evaluate(async (id) => (await fetch(`/api/studies/${id}`, { cache: 'no-store' })).status, studyId);
  expect(status).toBe(404);
});
