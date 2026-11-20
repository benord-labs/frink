import { expect, test, type Page } from '@playwright/test';
import { openApp } from './fixtures/app';
import { conversation, messageBox, openChat } from './fixtures/chat';
import { openTab, tabButton } from './fixtures/navigation';

const heading = (page: Page, name: string) => page.getByRole('heading', { name, exact: true });
const chatTitle = (page: Page) => page.getByRole('button', { name: 'Chat options', exact: true });

test('Chats, Flows and Queue are one tap apart, with no drawer', async ({ page }) => {
  await openApp(page);
  await expect(heading(page, 'Chats')).toBeVisible();
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  for (const name of ['Flows', 'Queue', 'Chats'] as const) {
    await tabButton(page, name).click();
    await expect(heading(page, name)).toBeVisible();
    await expect(page.getByTestId('computer-button').filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: `test-results/shell-${name.toLowerCase()}.png` });
  }
  await expect(page.getByTestId('history-open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveCount(0);
  await page.getByTestId('computer-button').filter({ visible: true }).click();
  await expect(heading(page, 'Settings')).toBeVisible();
  await page.screenshot({ path: 'test-results/shell-settings.png' });
});

test('each tab keeps its own place', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await expect(chatTitle(page)).toContainText('Fix flaky checkout tests');
  await page.getByTestId('queue-open').click();
  await expect(heading(page, 'Queue')).toBeVisible();
  await tabButton(page, 'Flows').click();
  await expect(heading(page, 'Flows')).toBeVisible();
  await tabButton(page, 'Chats').click();
  await expect(chatTitle(page)).toContainText('Fix flaky checkout tests');
});

test('a draft and its attachment survive a Queue review in another tab', async ({ page }) => {
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
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-row-task-plan').click();
  await expect(page.getByTestId('chat-transcript').filter({ visible: true })).toBeVisible();
  await openTab(page, 'Queue');
  await tabButton(page, 'Chats').click();
  await expect(messageBox(page)).toHaveValue('Keep this unfinished review');
  await expect(page.getByRole('button', { name: 'Remove review.txt' })).toBeVisible();
});

test('deleting a chat in the Queue returns there and closes it in Chats too', async ({ page }) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await page.getByTestId('queue-open').click();
  await page.getByTestId('queue-row-task-run-chat').click();
  await chatTitle(page).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => state.requests.filter((input) => input.type === 'deleteChat'))
    .toEqual([{ type: 'deleteChat', chatId: 'chat-1' }]);
  await expect(heading(page, 'Queue')).toBeVisible();
  await tabButton(page, 'Chats').click();
  await expect(heading(page, 'Chats')).toBeVisible();
  await expect(chatTitle(page)).toHaveCount(0);
});

test('rapid New chat presses from a Queue review preserve one return path', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await openTab(page, 'Queue');
  await page.getByTestId('queue-row-task-run-chat').click();
  await expect(chatTitle(page)).toBeVisible();
  await messageBox(page).fill('Keep the review draft');
  await page.getByTestId('new-chat').filter({ visible: true }).dblclick();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(messageBox(page)).toHaveValue('');
  await page.getByRole('link', { name: /back/i }).click();
  await expect(chatTitle(page)).toBeVisible();
  await expect(messageBox(page)).toHaveValue('Keep the review draft');
  await page.getByRole('link', { name: /back/i }).click();
  await expect(heading(page, 'Queue')).toBeVisible();
});

test('the compose button opens a blank chat that returns to the list', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(messageBox(page)).toHaveValue('');
  await expect(tabButton(page, 'Chats')).toBeHidden();
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
});

test('the conversation on screen reopens on launch; the list stays the list', async ({ page }) => {
  await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await page.reload();
  await expect(chatTitle(page)).toContainText('Fix flaky checkout tests');
  await page.getByRole('link', { name: /back/i }).click();
  await expect(heading(page, 'Chats')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  await expect(chatTitle(page)).toHaveCount(0);
});
