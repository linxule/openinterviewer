import { test, expect, GREETING, ANSWER } from './workflow-fixture';

// Synthetic external provider only; study save, consent and interview handlers are real.
for (const mode of ['off', 'device'] as const) {
  test(`${mode} voice: a Chromium without the local API hides the mic and allows a typed interview`, async ({ page, workflow }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('synthetic-e2e-admin-password');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(/\/studies$/);
    await page.goto('/setup');
    await page.getByLabel('Study Name *', { exact: true }).fill(`Synthetic ${mode} voice study`);
    await page.getByLabel('Research Question *', { exact: true }).fill('How do people resume research?');
    await page.getByPlaceholder('Question 1...', { exact: true }).fill('How do you return to a saved document?');
    await page.getByRole('radio', { name: /OpenAI/ }).check();
    if (mode === 'device') await page.getByRole('radio', { name: /On the participant’s computer/ }).check();
    await page.getByRole('button', { name: 'Save Study', exact: true }).click();
    await expect(page).toHaveURL(/\/studies\/[0-9a-f-]+$/);
    await page.getByRole('tab', { name: 'Study settings' }).click();
    await page.getByRole('button', { name: 'Generate New Link' }).click();
    const linkInput = page.locator('input[readonly]');
    await expect(linkInput).toHaveValue(/\/p\/[A-Za-z0-9_-]+$/);
    const context = await workflow.participantContext();
    await context.addInitScript(() => {
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    });
    const participant = await context.newPage();
    const transcriptionRequests: string[] = [];
    participant.on('request', request => {
      if (new URL(request.url()).pathname === '/api/transcribe') transcriptionRequests.push(request.url());
    });
    await participant.goto(new URL(await linkInput.inputValue()).pathname);
    if (mode === 'device') await expect(participant.getByText(/your browser turns your speech into text on this computer/)).toBeVisible();
    await participant.getByRole('button', { name: 'I consent — begin the interview' }).click();
    await expect(participant.getByText(GREETING, { exact: true })).toBeVisible();
    await expect(participant.getByRole('button', { name: 'Start voice input' })).toHaveCount(0);
    await participant.getByLabel('Your response').fill(ANSWER);
    await participant.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(participant.getByRole('heading', { name: /conversation complete/ })).toBeVisible();
    expect(transcriptionRequests).toEqual([]);
    await context.close();
  });
}
