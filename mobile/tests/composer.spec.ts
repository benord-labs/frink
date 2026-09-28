import { expect, test, type Page } from '@playwright/test';
import { mockCompanion } from './fixtures/companion';

async function openConversation(page: Page) {
  await page.getByRole('tab', { name: 'Chats', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'Prepare the next release' }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

const sent = (state: { requests: Array<Record<string, unknown>> }, type: string) =>
  state.requests.filter((request) => request.type === type);

test('the phone composer carries the desktop controls and saves each change on the computer', async ({
  page,
}) => {
  const state = await mockCompanion(page);
  await openConversation(page);

  const model = page.getByRole('button', { name: 'Model: Sonnet', exact: true });
  await expect(page.getByRole('button', { name: 'Mode: Agent', exact: true })).toBeVisible();
  await expect(model).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Auto', exact: true })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Thinking', exact: true })).toBeChecked();

  // Model family and effort, from one sheet.
  await model.click();
  await page.getByRole('radio', { name: 'Opus 4.8', exact: true }).click();
  await expect
    .poll(() => sent(state, 'updateComposer').at(-1))
    .toMatchObject({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      patch: { modelId: 'opus-4.8' },
    });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Model: Opus 4.8', exact: true })).toBeVisible();

  // Mode.
  await page.getByRole('button', { name: 'Mode: Agent', exact: true }).click();
  await page.getByRole('radio', { name: 'Plan', exact: true }).click();
  await expect.poll(() => sent(state, 'setMode').at(-1)).toMatchObject({ mode: 'plan' });
  await expect(page.getByRole('button', { name: 'Mode: Plan', exact: true })).toBeVisible();

  // Toggles save immediately.
  await page.getByRole('switch', { name: 'Auto', exact: true }).click();
  await expect
    .poll(() => sent(state, 'updateComposer').at(-1))
    .toMatchObject({
      patch: { autoMode: false },
    });
  await expect(page.getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();

  // Account.
  await page.getByRole('button', { name: 'Account: Work', exact: true }).click();
  await page.getByRole('radio', { name: 'Personal', exact: true }).click();
  await expect.poll(() => sent(state, 'setAccount').at(-1)).toMatchObject({ accountId: 'acc-2' });
});

test('an attached file uploads straight away and rides the message by id', async ({ page }) => {
  const state = await mockCompanion(page);
  await openConversation(page);

  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button').filter({ hasText: 'Files' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ship it'),
  });

  await expect(page.getByTestId('composer-attachment')).toContainText('notes.txt');
  await expect.poll(() => sent(state, 'upload').length).toBe(1);

  // An attachment alone is a message.
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect
    .poll(() => sent(state, 'sendMessage').at(-1))
    .toMatchObject({
      attachments: [expect.stringMatching(/^att-/)],
    });
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
});

test('quick taps on several controls are all saved, in order, while the computer is slow', async ({
  page,
}) => {
  const state = await mockCompanion(page);
  await openConversation(page);
  // Hold each composer save so the second tap lands while the first is still in flight.
  await page.route('**/api', async (route) => {
    if (route.request().postDataJSON()?.type === 'updateComposer') {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await route.fallback();
  });

  await page.getByRole('switch', { name: 'Auto', exact: true }).click();
  await page.getByRole('switch', { name: 'Thinking', exact: true }).click();

  await expect
    .poll(() => sent(state, 'updateComposer').map((request) => request.patch))
    .toEqual([{ autoMode: false }, { thinkingEnabled: false }]);
  await expect(page.getByRole('switch', { name: 'Auto', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Thinking', exact: true })).not.toBeChecked();
});
