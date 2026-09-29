import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { DEFAULT_OPENAI_MODEL } from '../../src/types';
import { test, expect, ANSWER, GREETING, INSIGHT, UNSAID } from './workflow-fixture';
import { deletePopulatedStudy, exploreAndReplay, expectStudyRevision } from './release-journey';
import { EXPLORATION_TEXT } from '../e2e-cloudflare/fixtureData.mjs';

async function createStudy(page: Page, collectExperience = false) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('synthetic-e2e-admin-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL(/\/studies$/);
  await page.goto('/setup');
  await page.getByLabel('Study Name *', { exact: true }).fill('Synthetic workflow study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  if (collectExperience) await page.getByRole('button', { name: '+ Years of Experience', exact: true }).click();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  return page.url();
}

async function completeConversation(page: Page) {
  await page.getByRole('button', { name: 'I consent — begin the interview' }).click();
  await expect(page.getByText(GREETING, { exact: true })).toBeVisible();
  await page.getByLabel('Your response').fill(ANSWER);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: /conversation complete/ })).toBeVisible();
}

async function downloadText(page: Page, name: string | RegExp) {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!, 'utf8');
}

test('researcher creates a study; participants finalize; researcher reads, downloads and synthesizes saved interviews', async ({ page, workflow }, testInfo) => {
  const studyUrl = await createStudy(page);
  await page.getByRole('tab', { name: 'Study settings' }).click();
  await page.getByRole('button', { name: 'Generate New Link' }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
  const participantLink = await linkInput.inputValue();
  expect(new URL(participantLink).origin).toBe('https://workflow.example.test');

  // Participant one: the deferred analysis (scheduled from the save route's
  // `after()`, not a client call) fails on its first attempt. The
  // participant is saved and gone regardless — slice P's whole point.
  {
    const context = await workflow.participantContext();
    const participant = await context.newPage();
    await participant.goto(new URL(participantLink).pathname);
    await completeConversation(participant);
    workflow.failNextSynthesis = true;
    await participant.getByRole('button', { name: 'Continue to save interview' }).click();
    await expect(participant.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(participant.getByText('Your responses have been saved. It is now safe to close this tab.')).toBeVisible();
    await expect(participant.getByRole('button', { name: /retry finalization/i })).toHaveCount(0);

    // Refresh is a realistic retry surface: it must retain success without
    // creating a duplicate interview or invoking the provider again.
    await expect.poll(() => workflow.calls.filter(call => call.operation === 'synthesis').length).toBe(1);
    await participant.reload();
    await expect(participant.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    expect(workflow.calls.filter(call => call.operation === 'synthesis')).toHaveLength(1);
    await context.close();
  }

  // Participant two: a storage fault at save time is still the participant's
  // own retry (the transcript is only in the tab until the save lands).
  {
    const context = await workflow.participantContext();
    const participant = await context.newPage();
    await participant.goto(new URL(participantLink).pathname);
    await completeConversation(participant);
    workflow.storageOffline = true;
    await participant.getByRole('button', { name: 'Continue to save interview' }).click();
    await expect(participant.getByRole('heading', { name: "We couldn't save your interview" })).toBeVisible();
    workflow.storageOffline = false;
    await participant.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(participant.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await context.close();
  }

  await page.goto(studyUrl);
  await expect(page.getByText(/^2 interviews/)).toBeVisible();
  // The researcher shell must not overflow a phone: three rail destinations plus
  // the brand and Log out once pushed the top bar past 375px.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  await expect(page.getByRole('button', { name: /View interview \d/ })).toHaveCount(2);

  // A failed batch request must retain the register, including on a phone,
  // rather than reloading into an empty state during the same outage.
  await page.setViewportSize({ width: 375, height: 812 });
  workflow.storageOffline = true;
  await page.getByRole('button', { name: /^Analyze \d+ pending$/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Analysis batch stopped' })).toBeVisible();
  await expect(page.getByRole('button', { name: /View interview \d/ })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('analysis-batch-recovery-mobile.png'), fullPage: true });
  workflow.storageOffline = false;
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('button', { name: 'View interview 1', exact: true }).click();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  const transcript = await downloadText(page, 'Download transcript');
  expect(transcript).toContain(ANSWER);
  expect(transcript).toContain(GREETING);
  const interview = JSON.parse(await downloadText(page, 'Download JSON'));
  expect(interview.transcript.some((turn: { content: string }) => turn.content === ANSWER)).toBe(true);
  // The interview record's own conducting fields are written at save time,
  // from the study config's own (never Gateway-mapped) model id, independent
  // of whether the analysis has run yet.
  expect(interview.conductedByProvider).toBe('openai');
  expect(interview.conductedByModel).toBe(DEFAULT_OPENAI_MODEL);
  const transport = testInfo.project.name.endsWith('gateway') ? 'gateway' : 'direct';
  // Synthesis now uses the study's own configured model — the same one the
  // interview turns used — never a separate fixed synthesis model. Under the
  // Gateway, the actually-executed model id carries the transport mapping;
  // conductedByModel above never does.
  const studyModel = transport === 'gateway' ? `openai/${DEFAULT_OPENAI_MODEL}` : DEFAULT_OPENAI_MODEL;
  // The analysis writer, not the save route, sets these — so at this point
  // (analysis still pending or failed) they are absent from the record.
  expect(interview.aiModel).toBeUndefined();

  // Participant one's interview: the deferred analysis failed. The Analysis
  // tab is honest about that — pending (the deferred run has not landed yet)
  // or failed (it already has) are both correct, depending on timing.
  // Standalone detail links also work without a studyId query. Recovery must
  // use the study id from the interview loaded by the server.
  await page.goto(new URL(page.url()).pathname);
  await page.getByRole('tab', { name: 'Analysis', exact: true }).click();
  const runAnalysis = page.getByRole('button', { name: 'Run analysis', exact: true });
  await expect(runAnalysis).toBeVisible();
  await expect(page.getByText(/^Analysis (pending|failed)$/)).toBeVisible();

  // A storage refusal is visible and leaves the transcript available. Retry
  // goes through the real analysis API after the synthetic outage is lifted.
  await page.setViewportSize({ width: 375, height: 812 });
  workflow.storageOffline = true;
  await runAnalysis.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Analysis is temporarily unavailable. Please try again.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('analysis-recovery-mobile.png'), fullPage: true });
  workflow.storageOffline = false;
  await runAnalysis.click();
  await expect(page.getByText(INSIGHT, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Analysis' }).getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  // The concrete consequence of feat/synthesis-uses-study-model: the
  // analysis footer names the study's own model, not a fixed override.
  const footer = page.getByText(/^Conducted by/);
  await expect(footer).toContainText(`Synthesized by ${studyModel}`);

  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Interviews', exact: true }).click();
  // Participant two's deferred analysis may still be pending or already
  // complete depending on timing; the batch action recovers whichever is
  // still pending before the aggregate needs both.
  const pendingButton = page.getByRole('button', { name: /^Analyze \d+ pending$/ });
  if (await pendingButton.isVisible().catch(() => false)) {
    await pendingButton.click();
    await expect(pendingButton).toHaveCount(0);
  }

  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze selected interviews', exact: true }).click();
  await expect(page.getByText('Context notes help both participants resume work.', { exact: true })).toBeVisible();
  await expect(page.getByText('Investigate when notes are written.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Divergent Views', exact: true })).toHaveCount(0);

  // Aggregate citations (Slice L): ANSWER's ref verifies (both synthetic
  // interviews share turn 2), UNSAID's never locates — the pair that proves
  // the whole chain end to end. Exactly one wine numeral must exist: the
  // absence of a trigger is the signal that UNSAID's ref did not verify.
  await expect(page.getByRole('button', { name: /^t\.\d+$/ })).toHaveCount(1);
  const citationTrigger = page.getByRole('button', { name: 't.2', exact: true });
  await expect(citationTrigger).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();
  await expect(page.getByText(/^P0\d · turn 2$/)).toBeVisible();
  const traceLink = page.getByRole('link', { name: /^Read in P0\d's transcript$/ });
  await expect(traceLink).toBeVisible();
  await expect(traceLink).toHaveAttribute('href', /turn=2/);
  await expect(page.getByText(UNSAID)).toBeVisible();

  await expect(page.getByText(/· saved /)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/not saved/);
  expect(await page.locator('body').innerText()).not.toMatch(/receipt (eyJ|unsigned)/);
  // Ruling 4: the default thank-you text is visible on the receipt, and the
  // document contains no bracketed authoring placeholder.
  expect(await page.locator('body').innerText()).not.toContain('[');

  await traceLink.click();
  await expect(page).toHaveURL(/\/dashboard\/interview\/[^/?]+\?studyId=[^&]+&turn=2$/);
  const tracedTurn = page.locator('#turn-2');
  await expect(tracedTurn).toBeFocused();
  await expect(tracedTurn).toHaveClass(/trace-ring/);

  // The stored analysis survives a reload with no further provider call: the
  // whole point of persistence (slice-N-spec.md N14).
  await page.goto(studyUrl);
  await expect(page.getByText('Context notes help both participants resume work.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 't.2', exact: true })).toBeVisible();
  await expect(page.getByText(/· saved /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze selected interviews', exact: true })).toBeVisible();

  const studyId = new URL(studyUrl).pathname.split('/').pop()!;
  const answer = await exploreAndReplay(page, studyId);
  expect(answer.scope.selectedCount).toBe(2);
  expect(answer.scope.pendingAnalysisCount).toBe(0);
  expect(workflow.calls.filter(call => call.operation === 'exploration')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('study-exploration-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('study-exploration-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('tab', { name: 'Study settings', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export this study', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloaded).path())!));
  const exportedAnswer = JSON.parse(await zip.file(`explorations/${studyId}/${answer.id}.json`)!.async('string'));
  expect(exportedAnswer).toEqual(answer);
  expect(JSON.parse(await zip.file(`aggregates/${studyId}.json`)!.async('string')).interviewCount).toBe(2);
  await deletePopulatedStudy(page, studyId, answer.scope.sources.map(source => source.interviewId), {
    desktop: testInfo.outputPath('study-danger-zone-desktop.png'), mobile: testInfo.outputPath('study-danger-zone-mobile.png'),
  });
  const expiredContext = await workflow.participantContext();
  const expiredLink = await expiredContext.newPage();
  await expiredLink.goto(new URL(participantLink).pathname);
  await expect(expiredLink.getByRole('heading', { name: 'Unable to Load Interview', exact: true })).toBeVisible();
  await expiredContext.close();

  expect(workflow.calls.filter(call => call.operation === 'aggregate')).toHaveLength(1);
  expect(workflow.calls.filter(call => call.operation === 'greeting')).toHaveLength(2);
  expect(workflow.calls.filter(call => call.operation === 'interview')).toHaveLength(2);
  expect(new Set(workflow.calls.map(call => call.transport))).toEqual(new Set([transport]));
});

test('researcher preview can export its transcript after synthesis fails without storing research records', async ({ page, workflow }, testInfo) => {
  const studyUrl = await createStudy(page);
  const studyId = new URL(studyUrl).pathname.split('/').pop()!;
  await page.goto(`/setup?prefill=edit&studyId=${studyId}`);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await completeConversation(page);
  workflow.failNextSynthesis = true;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Continue preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Analysis Failed', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-recovery-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Export transcript', exact: true }).click();
  expect(await downloadText(page, /^Download Transcript/)).toContain(ANSWER);
  await page.goto(studyUrl);
  await expect(page.getByText('0 interviews', { exact: true })).toBeVisible();
});

test('pause resumes the same link; historical failed-analysis transcripts and unknown profile filters remain explicit; an unsaved answer retries only storage', async ({ page, workflow }) => {
  const studyUrl = await createStudy(page, true);
  const studyId = new URL(studyUrl).pathname.split('/').pop()!;
  await page.getByRole('tab', { name: 'Study settings', exact: true }).click();
  await page.getByRole('button', { name: 'Generate New Link', exact: true }).click();
  const linkInput = page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
  const originalPath = new URL(await linkInput.inputValue()).pathname;
  const access = page.getByRole('switch', { name: 'Participant access', exact: true });
  await access.click();
  await expect(access).toHaveAttribute('aria-checked', 'false');
  await expectStudyRevision(page, studyId, 1);
  const pausedContext = await workflow.participantContext();
  const paused = await pausedContext.newPage();
  await paused.goto(originalPath);
  await expect(paused.getByRole('heading', { name: 'Unable to Load Interview', exact: true })).toBeVisible();
  await pausedContext.close();
  await access.click();
  await expect(access).toHaveAttribute('aria-checked', 'true');
  await expectStudyRevision(page, studyId, 1);
  workflow.nextProfileUpdates = [{ fieldId: 'experience', value: '5', status: 'extracted' }];
  workflow.failNextSynthesis = true;
  const firstContext = await workflow.participantContext();
  const first = await firstContext.newPage();
  await first.goto(originalPath);
  await completeConversation(first);
  await first.getByRole('button', { name: 'Continue to save interview', exact: true }).click();
  await expect(first.getByRole('heading', { name: 'Thank you', exact: true })).toBeVisible();
  await expect.poll(() => workflow.calls.filter(call => call.operation === 'synthesis').length).toBe(1);
  await firstContext.close();

  await page.getByRole('button', { name: 'Edit study', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/setup\\?prefill=edit&studyId=${studyId}$`));
  await page.getByRole('button', { name: 'Edit Study Details', exact: true }).click();
  await page.getByLabel('Description (optional)', { exact: true }).fill('A changed collection protocol for the second revision.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Update Study', exact: true }).click();
  await expect(page).toHaveURL(studyUrl);
  await expectStudyRevision(page, studyId, 2);
  await page.getByRole('tab', { name: 'Study settings', exact: true }).click();
  await page.getByRole('button', { name: 'Generate New Link', exact: true }).click();
  await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
  const currentPath = new URL(await linkInput.inputValue()).pathname;
  expect(currentPath).not.toBe(originalPath);
  workflow.nextProfileUpdates = [{ fieldId: 'experience', value: null, status: 'refused' }];
  workflow.failNextSynthesis = true;
  const secondContext = await workflow.participantContext();
  const second = await secondContext.newPage();
  await second.goto(currentPath);
  await completeConversation(second);
  await second.getByRole('button', { name: 'Continue to save interview', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Thank you', exact: true })).toBeVisible();
  await expect.poll(() => workflow.calls.filter(call => call.operation === 'synthesis').length).toBe(2);
  await secondContext.close();

  await page.goto(studyUrl);
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await page.getByLabel('Recorded field', { exact: true }).selectOption('experience');
  await page.getByLabel('Match', { exact: true }).selectOption('number-between');
  await page.getByLabel('Minimum', { exact: true }).fill('3');
  await page.getByLabel('Maximum', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Add profile filter', exact: true }).click();
  await page.getByRole('button', { name: 'Apply dataset selection', exact: true }).click();
  await expect(page.getByText('1 selected · 2 retained · 1 excluded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1 unknown for the profile filters · 1 selected without complete individual analysis', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Question for these interviews', { exact: true }).fill('What is overlooked in the experienced participant’s failed-analysis transcript?');
  workflow.interruptStorageAfterExploration = true;
  const answered = page.waitForResponse(response => /\/exploration$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ask of the selected transcripts', exact: true }).click();
  const generated = await (await answered).json();
  expect(generated.unsaved).toBe(true);
  expect(generated.answer.scope).toMatchObject({ selectedCount: 1, totalSaved: 2, unknownProfileCount: 1, pendingAnalysisCount: 1 });
  expect(generated.answer.scope.sources[0].studyRevision).toBe(1);
  await expect(page.getByText(EXPLORATION_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByText('Generated, but saving was not confirmed.', { exact: false })).toBeVisible();
  workflow.storageOffline = false;
  await page.getByRole('button', { name: 'Retry saving this answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saving this answer', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await expect(page.getByText(EXPLORATION_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByText('Revisions: 1. 1 selected transcripts lacked complete individual analysis.', { exact: true })).toBeVisible();
  expect(workflow.calls.filter(call => call.operation === 'exploration')).toHaveLength(1);
  expect(workflow.calls.filter(call => call.operation === 'synthesis')).toHaveLength(2);
});

test('new, duplicate and reload-edit intents save distinct canonical studies without mutating their source', async ({ page, workflow }, testInfo) => {
  const originalUrl = await createStudy(page);
  const originalId = new URL(originalUrl).pathname.split('/').pop()!;
  const original = await page.evaluate(async id => (await (await fetch(`/api/studies/${id}`)).json()).study, originalId);
  await page.goto('/setup');
  await expect(page.getByLabel('Study Name *', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
  await page.getByLabel('Study Name *', { exact: true }).fill('A separate newly created study');
  await page.getByLabel('Research Question *', { exact: true }).fill('How is the separate study configured?');
  await page.getByPlaceholder('Question 1...', { exact: true }).fill('What is specific to this study?');
  await page.getByRole('radio', { name: /OpenAI/ }).check();
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  const newId = new URL(page.url()).pathname.split('/').pop()!;
  expect(newId).not.toBe(originalId);

  await page.goto('/studies');
  const sourceRow = page.getByRole('row').filter({ has: page.getByText(original.config.name, { exact: true }) });
  await sourceRow.getByRole('button', { name: 'Actions', exact: true }).click();
  await sourceRow.getByRole('button', { name: 'Duplicate as test study', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/setup\\?prefill=duplicate&studyId=${originalId}$`));
  await expect(page.getByLabel('Study Name *', { exact: true })).toHaveValue(`${original.config.name} — test`);
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
  const created = page.waitForRequest(request => new URL(request.url()).pathname === '/api/studies' && request.method() === 'POST');
  await page.getByRole('button', { name: 'Save Study', exact: true }).click();
  const request = await created;
  expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
  const duplicateId = new URL(page.url()).pathname.split('/').pop()!;
  expect(new Set([originalId, newId, duplicateId]).size).toBe(3);
  const records = await page.evaluate(async ids => Promise.all(ids.map(async id => (await (await fetch(`/api/studies/${id}`)).json()).study)), [originalId, duplicateId]);
  expect(records[0]).toEqual(original);
  expect(records[1]).toMatchObject({ id: duplicateId, revision: 1, interviewCount: 0 });
  expect(records[1].config.id).toBe(duplicateId);
  expect(records[1].config.parentStudyId).toBeUndefined();

  // Reloading an edit must load its canonical target, not the most recently
  // saved duplicate or a one-use prefill from another intent.
  await page.goto(`/setup?prefill=edit&studyId=${newId}`);
  await expect(page.getByText('A separate newly created study', { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Edit Study Details', exact: true }).click();
  await expect(page.getByLabel('Study Name *', { exact: true })).toHaveValue('A separate newly created study');
  await expect(page.getByLabel('Research Question *', { exact: true })).toHaveValue('How is the separate study configured?');
  await expectStudyRevision(page, newId, 1);
  await page.screenshot({ path: testInfo.outputPath('study-edit-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('study-edit-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Hold the real PUT at the browser network boundary (not an API mock).
  // The researcher cannot edit past the exact version being saved.
  await page.getByLabel('Description (optional)', { exact: true }).fill('The version captured by this save.');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const updatePath = `/api/studies/${newId}`;
  await page.route(url => url.pathname === updatePath, async route => {
    if (route.request().method() === 'PUT') await held;
    await route.continue();
  });
  const saving = page.waitForRequest(request => new URL(request.url()).pathname === updatePath && request.method() === 'PUT');
  await page.getByRole('button', { name: 'Update Study', exact: true }).click();
  const submitted = await saving;
  await expect(page.getByRole('status').filter({ hasText: 'Saving this version.' })).toBeVisible();
  await expect(page.getByLabel('Study Name *', { exact: true }).fill('A later unsaved edit', { timeout: 500 })).rejects.toThrow();
  expect(submitted.postDataJSON().config.name).toBe('A separate newly created study');
  await expect(page.getByLabel('Study Name *', { exact: true })).toHaveValue('A separate newly created study');
  release();
  await expect(page).toHaveURL(new RegExp(`/studies/${newId}$`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await expectStudyRevision(page, newId, 2);
  expect(workflow.calls).toEqual([]);
});
