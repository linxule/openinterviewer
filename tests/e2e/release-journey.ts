// Shared release journeys exercise actual application APIs through the
// researcher's browser cookie. Only outbound provider responses are fixtures.
import { expect, type Page } from '@playwright/test';
import type { ExplorationAnswer } from '../../src/lib/exploration/types';
import { EXPLORATION_TEXT, UNSAID } from '../e2e-cloudflare/fixtureData.mjs';

export const EXPLORATION_QUESTION = 'Generate three provisional archetypes and show the evidence and exceptions.';

export async function exploreAndReplay(page: Page, studyId: string): Promise<ExplorationAnswer> {
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await page.getByRole('button', { name: 'Apply dataset selection', exact: true }).click();
  await page.getByLabel('Question for these interviews', { exact: true }).fill(EXPLORATION_QUESTION);
  const path = `/api/studies/${studyId}/exploration`;
  const submitted = page.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === 'POST');
  const responded = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ask of the selected transcripts', exact: true }).click();
  const [request, response] = await Promise.all([submitted, responded]);
  expect(response.status()).toBe(200);
  const { answer } = await response.json() as { answer: ExplorationAnswer };
  expect(answer.status).toBe('complete');
  await expect(page.getByText(EXPLORATION_TEXT, { exact: true })).toBeVisible();
  // Located participant words and fabricated/wrong-speaker claims are visibly
  // different. A located quotation does not validate its interpretation.
  await expect(page.getByRole('button', { name: / · t\.2$/ })).toHaveCount(1);
  await expect(page.getByText(UNSAID, { exact: true })).toBeVisible();
  await expect(page.getByText('Quotation not located in the selected participant record.', { exact: true })).toHaveCount(2);
  const replay = await page.evaluate(async input => {
    const response = await fetch(input.path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.key! }, body: input.body,
    });
    return { status: response.status, data: await response.json() };
  }, { path, key: request.headers()['idempotency-key'], body: request.postData()! });
  expect(replay.status).toBe(200);
  expect(replay.data.answer).toEqual(answer);
  await page.reload();
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await expect(page.getByText(EXPLORATION_TEXT, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh saved answers', exact: true }).click();
  await expect(page.getByRole('article', { name: `Answer to ${EXPLORATION_QUESTION}`, exact: true })).toHaveCount(1);
  return answer;
}

export async function deletePopulatedStudy(page: Page, studyId: string, interviewIds: string[], screenshots?: { desktop: string; mobile: string }): Promise<void> {
  await page.getByRole('tab', { name: 'Study settings', exact: true }).click();
  const deletions: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') deletions.push(request.url()); });
  await page.getByRole('button', { name: 'Delete study', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export before deletion', exact: true })).toBeVisible();
  expect(deletions).toEqual([]);
  await page.getByRole('button', { name: 'Continue to permanent deletion', exact: true }).click();
  const permanent = page.getByRole('button', { name: 'Permanently delete study and data', exact: true });
  await expect(permanent).toBeDisabled();
  expect(deletions).toEqual([]);
  await page.getByRole('checkbox', { name: 'I understand that this permanently removes the study and all its live research data.', exact: true }).check();
  if (screenshots) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: screenshots.desktop, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: screenshots.mobile, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await permanent.click();
  await expect(page).toHaveURL(/\/studies$/);
  expect(deletions).toHaveLength(1);
  // The study and every content-bearing derived surface are inaccessible. The
  // interview-id read also proves deletion wasn't merely hiding its list row.
  const statuses = await page.evaluate(async paths => Promise.all(paths.map(async path => (await fetch(path, { cache: 'no-store' })).status)), [
    `/api/studies/${studyId}`,
    `/api/studies/${studyId}/exploration`,
    `/api/interviews/export?studyId=${studyId}`,
    ...interviewIds.map(id => `/api/interviews/${id}?studyId=${studyId}`),
  ]);
  expect(statuses).toEqual(statuses.map(() => 404));
  // The aggregate read's existing absence contract is 200 + null (including a
  // study with no aggregate). Assert absence of content, not a new status code.
  const aggregate = await page.evaluate(async id => {
    const response = await fetch(`/api/studies/${id}/aggregate`, { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, studyId);
  expect(aggregate).toEqual({ status: 200, body: { aggregate: null } });
}

export async function expectStudyRevision(page: Page, studyId: string, revision: number): Promise<void> {
  const read = await page.evaluate(async id => {
    const response = await fetch(`/api/studies/${id}`, { cache: 'no-store' });
    return { status: response.status, data: await response.json() };
  }, studyId);
  expect(read.status).toBe(200);
  expect(read.data.study.revision).toBe(revision);
}
