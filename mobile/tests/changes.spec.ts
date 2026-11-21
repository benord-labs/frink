import { expect, test, type Page } from '@playwright/test';
import { openApp } from './fixtures/app';
import { conversation, messageBox, openChat, requestsOf } from './fixtures/chat';
import { chatChangesFixture } from './fixtures/changes';

const changesButton = (page: Page) => page.getByTestId('chat-changes').filter({ visible: true });
const line = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).filter({ visible: true });

async function openChanges(page: Page) {
  await changesButton(page).click();
  await expect(page.getByRole('heading', { name: 'Changes', exact: true })).toBeVisible();
}

test.describe('reviewing what a chat changed', () => {
  test('the header counts the changes without polling for them', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    await expect(changesButton(page)).toHaveText('+38 −12');
    await page.screenshot({ path: 'test-results/changes-header-dark.png' });
    const asked = requestsOf(state, 'chatChanges');
    expect(asked.at(-1)).toMatchObject({ chatId: 'chat-1', summaryOnly: true });
    await page.clock.runFor(10_000);
    expect(requestsOf(state, 'chatChanges')).toHaveLength(asked.length);
  });

  test('a clean worktree shows no count', async ({ page }) => {
    const clean = { additions: 0, deletions: 0, fileCount: 0, files: [], truncated: false };
    const state = await openApp(page, { data: { chat: conversation(), chatChanges: clean } });
    await openChat(page);
    await expect.poll(() => requestsOf(state, 'chatChanges').length).toBeGreaterThan(0);
    await page.clock.runFor(500);
    await expect(changesButton(page)).toHaveCount(0);
  });

  test('each file opens to a numbered diff and collapses on tap', async ({ page }) => {
    await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    await openChanges(page);
    await expect(page.getByText('3 files · +38 −12')).toBeVisible();
    await expect(line(page, '  await waitForFrame(frame, "ready");')).toBeVisible();
    await expect(
      page.getByText('Hidden because it may hold secrets.', { exact: false }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/changes-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: 'test-results/changes-light.png' });
    const file = page.getByRole('button', { name: /^tests\/checkout\.spec\.ts, 2 added/ });
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    await file.click();
    await expect(file).toHaveAttribute('aria-expanded', 'false');
    await expect(line(page, '  await waitForFrame(frame, "ready");')).toHaveCount(0);
  });

  test('a diff past the size cap says to open it on the computer', async ({ page }) => {
    const cut = { ...chatChangesFixture(), truncated: true };
    await openApp(page, { data: { chat: conversation(), chatChanges: cut } });
    await openChat(page);
    await openChanges(page);
    await expect(page.getByText('Too large to show here. Open it on your computer.')).toBeVisible();
  });

  test('holding a line turns it into a draft that names the file and line', async ({ page }) => {
    await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    await messageBox(page).fill('Looks close.');
    await openChanges(page);
    const offered: string[] = [];
    page.once('dialog', (dialog) => {
      offered.push(dialog.message());
      void dialog.accept();
    });
    await line(page, '  await waitForFrame(frame, "ready");').click({ delay: 800 });
    await expect(messageBox(page)).toHaveValue('Looks close.\ntests/checkout.spec.ts:41 - ');
    expect(offered).toEqual(['Ask for a change\n\ntests/checkout.spec.ts:41']);
  });
});
