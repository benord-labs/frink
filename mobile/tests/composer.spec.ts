import { expect, test } from '@playwright/test';
import { openApp } from './fixtures/app';
import { conversation, messageBox, openChat, requestsOf } from './fixtures/chat';
import { composerFixture } from './fixtures/data';

/** Opens the model's full settings from its menu and waits for the slide-up to settle. */
async function openModelSheet(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: `Model: ${label}`, exact: true }).click();
  await page.getByRole('radio', { name: 'More settings…', exact: true }).click();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  await expect
    .poll(async () => {
      const before = (await done.boundingBox())?.y;
      await page.waitForTimeout(150);
      return before !== undefined && before === (await done.boundingBox())?.y;
    })
    .toBe(true);
}

test('the model and mode are menus on the composer; rarer settings are saved from the sheet', async ({
  page,
}) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await expect(page.getByRole('button', { name: 'Mode: Agent', exact: true })).toBeVisible();
  // No toggles beside the box: Auto, Thinking and the account live in the model's settings.
  await expect(page.getByRole('switch')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/composer-idle-dark.png' });

  await openModelSheet(page, 'Sonnet');
  await expect(page.getByRole('radio', { name: 'Sonnet', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.screenshot({ path: 'test-results/composer-sheet-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'test-results/composer-sheet-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('radio', { name: 'Opus 4.8', exact: true }).click();
  await expect
    .poll(() => requestsOf(state, 'updateComposer').at(-1))
    .toMatchObject({ chatId: 'chat-1', subChatId: 'sub-1', patch: { modelId: 'opus-4.8' } });

  const auto = page.getByRole('switch', { name: 'Auto Mode', exact: true });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect
    .poll(() => requestsOf(state, 'updateComposer').at(-1))
    .toMatchObject({ patch: { autoMode: false } });
  await expect(auto).not.toBeChecked();

  await page.getByRole('radio', { name: 'Personal', exact: true }).click();
  await expect
    .poll(() => requestsOf(state, 'setAccount').at(-1))
    .toMatchObject({ accountId: 'acc-2' });

  await page.getByRole('switch', { name: 'Thinking', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model: Opus 4.8', exact: true })).toBeVisible();

  // A menu closes on pick.
  await page.getByRole('button', { name: 'Mode: Agent', exact: true }).click();
  await page.getByRole('radio', { name: 'Plan', exact: true }).click();
  await expect.poll(() => requestsOf(state, 'setMode').at(-1)).toMatchObject({ mode: 'plan' });
  await expect(page.getByRole('button', { name: 'Mode: Plan', exact: true })).toBeVisible();
});

test('a Codex chat runs Fast or Ultrafast, never both, and each shows its credit cost', async ({
  page,
}) => {
  const astra = {
    id: 'codex-gpt-6-astra-medium',
    name: 'GPT-6 Astra',
    familyId: 'codex-6-astra',
    contextLabel: 'Large context',
    effort: 'medium' as const,
    effortDefault: true,
    contextDefault: true,
  };
  const composer = {
    ...composerFixture(),
    provider: 'codex' as const,
    models: [astra],
    settings: { ...composerFixture().settings, modelId: astra.id },
    codexSpeedCredits: { fast: 2.5, ultrafast: 8 },
  };
  const state = await openApp(page, { data: { chat: conversation(), composer } });
  await openChat(page);
  await openModelSheet(page, 'GPT-6 Astra');

  const fast = page.getByRole('switch', { name: 'Fast', exact: true });
  const ultrafast = page.getByRole('switch', { name: 'Ultrafast', exact: true });
  await expect(page.getByText('Up to 8× faster. Uses 8× credits.')).toBeVisible();
  await fast.click();
  await ultrafast.click();
  await expect
    .poll(() => requestsOf(state, 'updateComposer').at(-1))
    .toMatchObject({ patch: { codexSpeed: 'ultrafast' } });
  await expect(ultrafast).toBeChecked();
  await expect(fast).not.toBeChecked();
  await page.screenshot({ path: 'test-results/composer-codex-ultrafast-dark.png' });

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Model: GPT-6 Astra', exact: true }),
  ).toBeVisible();
});

test('quick taps on several switches are all saved, in order, while the computer is slow', async ({
  page,
}) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  // Hold each composer save so the second tap lands while the first is still in flight.
  await page.route('**/api', async (route) => {
    if (route.request().postDataJSON()?.type === 'updateComposer')
      await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });
  await openModelSheet(page, 'Sonnet');
  await page.getByRole('switch', { name: 'Auto Mode', exact: true }).click();
  await page.getByRole('switch', { name: 'Thinking', exact: true }).click();
  await expect
    .poll(() => requestsOf(state, 'updateComposer').map((request) => request.patch))
    .toEqual([{ autoMode: false }, { thinkingEnabled: false }]);
  await expect(page.getByRole('switch', { name: 'Auto Mode', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Thinking', exact: true })).not.toBeChecked();
});

test('an attached file uploads straight away and rides the next send by id', async ({ page }) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('radio', { name: 'Files', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('ship it') });
  await expect(page.getByTestId('composer-attachment')).toContainText('notes.txt');
  await expect.poll(() => requestsOf(state, 'upload').length).toBe(1);
  await page.screenshot({ path: 'test-results/composer-attachment-dark.png' });
  // An attachment alone is a message.
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect
    .poll(() => requestsOf(state, 'sendMessage').at(-1))
    .toMatchObject({ attachments: [expect.stringMatching(/^att-/)] });
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
});

test('while Frink works the composer is text-only: no attach, no controls', async ({ page }) => {
  await openApp(page, { data: { chat: conversation({}, 'running') } });
  await openChat(page);
  await expect(messageBox(page)).toBeEditable();
  await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
  await expect(page.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mode: Agent', exact: true })).toHaveCount(0);
  // Stop turns into Send in the same place as soon as there is text.
  await messageBox(page).fill('Check the logs too');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await messageBox(page).fill('');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
});
