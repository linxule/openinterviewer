// Shared real-handler project journey. Each target supplies its sanctioned
// provider fixture and participant context; no application API is mocked.
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { hasProjectTranscriptsCompleteMarker } from '../../src/lib/export/projectTranscriptsMarkdown';
import { deletePopulatedStudy, expectStudyRevision } from './release-journey';
import { generateLink, pressUntilFocused } from '../e2e-cloudflare/journey';

export async function fillProjectStudy(page: Page, name: string) {
  await page.getByLabel('Study Name *', { exact: true }).fill(name);
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
}
async function saveProjectStudy(page: Page, name: string) {
  await fillProjectStudy(page, name);
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}
async function newProject(page: Page, name: string) {
  page.once('dialog', dialog => dialog.accept(name));
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
}
async function move(page: Page, name: string, projectId: string) {
  await page.getByRole('button', { name: `Open actions for ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Move to project…', exact: true }).click();
  await page.getByLabel('Destination project', { exact: true }).selectOption(projectId);
}
export async function projectsJourney(page: Page, options: {
  completeParticipant: (link: string) => Promise<void>;
  settled: (interviews: number) => Promise<void>;
  providerCount: () => Promise<number>;
}) {
  const suffix = Date.now().toString();
  const first = `Project first ${suffix}`, second = `Project second ${suffix}`, renamed = `Renamed ${suffix}`;
  const studyName = `Grouped study ${suffix}`, ungroupedName = `Ungrouped study ${suffix}`;
  await page.goto('/setup'); const ungroupedId = await saveProjectStudy(page, ungroupedName);
  await page.goto('/studies'); await newProject(page, first); await newProject(page, second);
  const snapshot = await page.evaluate(async () => (await fetch('/api/projects')).json());
  const firstId = snapshot.projects.find((p: { name: string }) => p.name === first).id;
  const secondId = snapshot.projects.find((p: { name: string }) => p.name === second).id;
  await expect(page.getByRole('region', { name: 'Ungrouped', exact: true }).getByRole('button', { name: ungroupedName, exact: true })).toBeVisible();
  await page.getByRole('region', { name: first, exact: true }).getByRole('button', { name: '+ Study', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/setup\\?projectId=${firstId}$`));
  const studyId = await saveProjectStudy(page, studyName);
  const link = await generateLink(page);
  await options.completeParticipant(link); await options.settled(1);
  const before = await options.providerCount();
  await page.goto('/studies'); await page.reload();
  const group = page.getByRole('region', { name: first, exact: true });
  await expect(group.getByRole('button', { name: studyName, exact: true })).toBeVisible();
  const disclosure = group.getByRole('button', { name: `${first} 1 study`, exact: true });
  await pressUntilFocused(page, disclosure); await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false'); await expect(disclosure).toBeFocused();
  await page.keyboard.press('Enter'); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('button', { name: `Project actions for ${first}`, exact: true });
  await pressUntilFocused(page, menu); await page.keyboard.press('Enter');
  await pressUntilFocused(page, page.getByRole('button', { name: 'Rename', exact: true }));
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  page.once('dialog', dialog => dialog.accept(renamed));
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('region', { name: renamed, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await move(page, studyName, secondId);
  await expect(page.getByRole('region', { name: second, exact: true }).getByRole('button', { name: studyName, exact: true })).toBeVisible();
  await expectStudyRevision(page, studyId, 1);
  await page.getByRole('button', { name: `Project actions for ${second}`, exact: true }).click();
  page.once('dialog', dialog => { expect(dialog.message()).toBe('Delete this project? Its studies will move to Ungrouped. No study or interview will be deleted.'); return dialog.accept(); });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Ungrouped', exact: true }).getByRole('button', { name: studyName, exact: true })).toBeVisible();
  expect(await options.providerCount()).toBe(before);
  await options.completeParticipant(link); await options.settled(2);
  const afterParticipants = await options.providerCount();
  await page.goto('/studies'); await move(page, studyName, firstId);
  await expect(page.getByRole('region', { name: renamed, exact: true }).getByRole('button', { name: studyName, exact: true })).toBeVisible();
  await move(page, ungroupedName, firstId);
  await expect(page.getByRole('region', { name: renamed, exact: true }).getByRole('button', { name: ungroupedName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Project actions for ${renamed}`, exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export transcripts', exact: true }).click();
  const download = await downloaded; expect(await download.failure()).toBeNull();
  const text = await readFile((await download.path())!, 'utf8');
  expect(hasProjectTranscriptsCompleteMarker(text)).toBe(true);
  expect(text).toContain(`- Study ID: ${studyId}`); expect(text).toContain(`- Study ID: ${ungroupedId}`);
  const records = await page.evaluate(async id => (await fetch(`/api/interviews?studyId=${id}`)).json(), studyId);
  const interviewIds = records.interviews.map((i: { id: string }) => i.id);
  expect(interviewIds).toHaveLength(2);
  for (const id of interviewIds) expect(text).toContain(`- Interview ID: ${id}`);
  expect(await options.providerCount()).toBe(afterParticipants);
  await page.goto(`/studies/${studyId}`); await deletePopulatedStudy(page, studyId, interviewIds);
  const final = await page.evaluate(async () => (await fetch('/api/projects')).json());
  expect(final.memberships.some((m: { studyId: string }) => m.studyId === studyId)).toBe(false);
  await expect(page.getByRole('button', { name: studyName, exact: true })).toHaveCount(0);
}

/** Real storage change: the target is deleted in another operation before save. */
export async function projectAssignmentFailureJourney(page: Page) {
  const name = `Deleted before assignment ${Date.now()}`;
  await page.goto('/studies'); await newProject(page, name);
  await page.getByRole('region', { name, exact: true }).getByRole('button', { name: '+ Study', exact: true }).click();
  const projectId = new URL(page.url()).searchParams.get('projectId')!;
  await fillProjectStudy(page, 'Study survives assignment failure');
  const deleted = await page.evaluate(async id => (await fetch(`/api/projects/${id}`, { method: 'DELETE' })).status, projectId);
  expect(deleted).toBe(200);
  let creates = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/studies' && request.method() === 'POST') creates += 1; });
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+\?projectAssignmentFailed=1$/);
  await expect(page.getByRole('status')).toContainText('Study saved, but it was not added to the project. Move it from the study list.');
  await page.reload(); expect(creates).toBe(1);
  await page.goto('/studies');
  await expect(page.getByRole('region', { name: 'Ungrouped', exact: true }).getByRole('button', { name: 'Study survives assignment failure', exact: true })).toBeVisible();
}
