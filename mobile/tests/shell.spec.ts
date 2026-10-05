import { expect, test } from '@playwright/test';
import { openApp } from './fixtures/app';
import { conversation, messageBox, openChat } from './fixtures/chat';
import { overviewFixture } from './fixtures/data';
import { openHistory, openDestination } from './fixtures/navigation';

test('conversation first, with Queue one tap away and tools in History', async ({ page }) => {
  const state = await openApp(page);
  await expect(messageBox(page)).toBeVisible();
  await expect(messageBox(page)).not.toBeFocused();
  await expect(page.getByTestId('queue-open')).toContainText('5');
  state.data.overview = { ...overviewFixture(), queue: [], questions: [], permissions: [] };
  await page.clock.runFor(3500);
  await expect(page.getByTestId('queue-open')).not.toContainText(/\d/);
  await page.getByTestId('queue-open').click();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  for (const destination of ['Flows', 'Settings'] as const) {
    await openDestination(page, destination);
    await page.screenshot({ path: `test-results/shell-${destination.toLowerCase()}.png` });
  }
  await page.getByRole('link', { name: /back/i }).click();
  await expect(messageBox(page)).toBeVisible();
});

test('History closes on Escape and restores the opener focus', async ({ page }) => {
  await openApp(page);
  await openHistory(page);
  await page.getByRole('textbox', { name: 'Search chats' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-panel')).toHaveCount(0);
  await expect(page.getByTestId('history-open')).toBeFocused();
});

test('a draft and its attachment survive History and a Queue review', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await messageBox(page).fill('Keep this unfinished review');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('radio', { name: 'Files', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'review.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await expect(page.getByRole('button', { name: 'Remove review.txt' })).toBeVisible();
  await openHistory(page);
  await page.getByRole('button', { name: 'Close history', exact: true }).click();
  await expect(messageBox(page)).toHaveValue('Keep this unfinished review');
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-row-task-plan').click();
  await expect(page.getByTestId('chat-transcript').filter({ visible: true })).toBeVisible();
  await page.getByRole('link', { name: /back/i }).click();
  await page.getByRole('link', { name: /back/i }).click();
  await expect(messageBox(page)).toHaveValue('Keep this unfinished review');
  await expect(page.getByRole('button', { name: 'Remove review.txt' })).toBeVisible();
});

test('deleting a Queue review also clears the same chat retained underneath', async ({ page }) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-row-task-run-chat').click();
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => state.requests.filter((input) => input.type === 'deleteChat'))
    .toEqual([{ type: 'deleteChat', chatId: 'chat-1' }]);
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toHaveCount(0);
});

test('rapid New chat presses from a Queue review preserve one return path', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-row-task-run-chat').click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  await messageBox(page).fill('Keep the review draft');
  await page.getByTestId('new-chat').filter({ visible: true }).dblclick();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(messageBox(page)).toHaveValue('');
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  await expect(messageBox(page)).toHaveValue('Keep the review draft');
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
});

test('New chat at the root opens a blank composer without a return route', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await page.getByTestId('new-chat').click();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toHaveCount(0);
  await expect(messageBox(page)).toHaveValue('');
  await expect(page.getByRole('link', { name: /back/i })).toHaveCount(0);
  await openHistory(page);
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
});
