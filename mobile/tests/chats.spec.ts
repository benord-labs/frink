import { openHistory } from './fixtures/navigation';
import { expect, test, type Page } from '@playwright/test';
import { openApp, type AppState } from './fixtures/app';
import { chatsPage, NOW } from './fixtures/data';

/** The computer's chats search: names or projects containing the query, then the window. */
function searchChats(input: Record<string, unknown>) {
  const limit = Number(input.limit ?? 30);
  const query = String(input.query ?? '').toLowerCase();
  const all = chatsPage(200)
    .items.filter((chat) => `${chat.name} ${chat.projectName}`.toLowerCase().includes(query))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return { items: all.slice(0, limit), hasMore: limit < all.length };
}

/** 250 chats, one an hour back from now: more than the phone will list without a search. */
function longHistory(input: Record<string, unknown>) {
  const base = chatsPage(40).items;
  const all = Array.from({ length: 250 }, (_, index) => ({
    ...base[index % base.length],
    id: `chat-${index + 1}`,
    lastActiveAt: new Date(NOW - index * 3_600_000).toISOString(),
  }));
  const limit = Number(input.limit ?? 30);
  return { items: all.slice(0, limit), hasMore: limit < all.length };
}

async function openChats(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, {
    respond: (input) => (input.type === 'chats' ? searchChats(input) : undefined),
    ...options,
  });
  await openHistory(page);
  return state;
}

const requestsOf = (state: AppState, type: string) =>
  state.requests.filter((input) => input.type === type);

test('chats group by project with compact rows and a project-specific compose action', async ({
  page,
}) => {
  await openChats(page);
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  const project = page.getByRole('button', { name: 'frink, project', exact: true });
  await expect(project).toBeVisible();
  const running = page.getByTestId('chat-row-chat-1');
  await expect(running).toContainText('Fix flaky checkout tests');
  await expect(running).toContainText('Running');
  await expect(page.getByTestId('chat-row-chat-2')).toContainText('Background');
  await expect(running).not.toContainText('Chat · frink');
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/chats-list-dark.png' });
  await project.click();
  await expect(running).toHaveCount(0);
  await project.click();
  await expect(running).toBeVisible();
  await page.getByRole('button', { name: 'New chat in frink', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: frink', exact: true })).toBeVisible();
});

test('search asks the computer once typing pauses, and says when nothing matches', async ({
  page,
}) => {
  const state = await openChats(page);
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Search chats' });
  await field.pressSequentially('invoice', { delay: 30 });
  await expect(page.getByTestId('chat-row-chat-4')).toBeVisible();
  await expect(page.getByTestId('chat-row-chat-1')).toHaveCount(0);
  const queries = requestsOf(state, 'chats')
    .map((input) => input.query)
    .filter(Boolean);
  expect(queries).toEqual(['invoice']);
  await page.screenshot({ path: 'test-results/chats-search-dark.png' });

  await field.fill('zebra');
  await expect(page.getByText('No chats match “zebra”')).toBeVisible();
  await page.screenshot({ path: 'test-results/chats-no-results-dark.png' });
});

test('scrolling to the end asks for a longer list', async ({ page }) => {
  const state = await openChats(page);
  const rows = page.locator('[data-testid^="chat-row-"]');
  await expect(rows).toHaveCount(30);
  await page.mouse.move(195, 420);
  await page.mouse.wheel(0, 10000);
  // Rows already shown stay while the longer list loads, then the rest arrive.
  await expect(rows).toHaveCount(40);
  expect(requestsOf(state, 'chats').map((input) => input.limit)).toEqual([30, 60]);

  // A new search starts from the first page: its very first request already asks for 30.
  await page.mouse.wheel(0, -20000);
  await page.getByRole('textbox', { name: 'Search chats' }).fill('invoice');
  await expect(page.getByTestId('chat-row-chat-1')).toHaveCount(0);
  const searches = requestsOf(state, 'chats').filter((input) => input.query);
  expect(searches.map((input) => input.limit)).toEqual([30]);
});

test('the list stops at the latest 200 chats and points to search', async ({ page }) => {
  const state = await openChats(page, {
    respond: (input) => (input.type === 'chats' ? longHistory(input) : undefined),
  });
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  const note = page.getByText('Showing your latest 200 chats. Search to find older ones.');
  await page.mouse.move(195, 420);
  for (let tries = 0; tries < 60 && !(await note.isVisible()); tries++) {
    await page.mouse.wheel(0, -300);
    await page.mouse.wheel(0, 8000);
    await page.waitForTimeout(250);
  }
  await expect(note).toBeVisible();
  // The virtualised list settles its row heights as it scrolls, so wheel until the note stays put
  // above the fixed History footer.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(250);
      const box = await note.boundingBox();
      return !!box && box.y > 0 && box.y + box.height < 760;
    })
    .toBe(true);
  await page.screenshot({ path: 'test-results/chats-cap-dark.png' });
  // At the cap, reaching the end again asks for nothing more.
  const asked = requestsOf(state, 'chats').length;
  await page.mouse.wheel(0, -600);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(400);
  expect(Math.max(...requestsOf(state, 'chats').map((input) => Number(input.limit)))).toBe(200);
  expect(requestsOf(state, 'chats').length - asked).toBeLessThanOrEqual(1);
});

async function swipeOpen(page: Page, id: string, name: string) {
  const action = page.getByRole('button', { name: `Delete ${name}`, exact: true });
  // Rows gain their swipe scroller once measured, so wait for the action before scrolling to it.
  await expect(action).toBeAttached();
  await page.getByTestId(`chat-row-${id}`).scrollIntoViewIfNeeded();
  await expect(action).not.toBeInViewport();
  // The swipe: scroll the row's own horizontal scroller by the action's width
  // (react-native-web replaces scrollTo, so set scrollLeft directly).
  await action.evaluate((button) => {
    let node = button.parentElement;
    while (node && node.scrollWidth <= node.clientWidth) node = node.parentElement;
    if (node) node.scrollLeft = node.scrollWidth;
  });
  await expect(action).toBeInViewport();
  return action;
}

test('swiping a chat left deletes it after asking', async ({ page }) => {
  const state = await openChats(page);
  const action = await swipeOpen(page, 'chat-4', 'Refactor the invoice PDF renderer');
  await page.screenshot({ path: 'test-results/chats-swipe-dark.png' });

  page.once('dialog', (dialog) => void dialog.dismiss());
  await action.click();
  await page.waitForTimeout(200);
  expect(requestsOf(state, 'deleteChat')).toEqual([]);

  page.once('dialog', (dialog) => void dialog.accept());
  await action.click();
  await expect
    .poll(() => requestsOf(state, 'deleteChat'))
    .toEqual([{ type: 'deleteChat', chatId: 'chat-4' }]);
});

test('a chat the computer won’t delete explains why', async ({ page }) => {
  const reason = 'This chat belongs to a Flow run. Delete the run in Frink on your Mac.';
  await openChats(page, {
    respond: (input) => {
      if (input.type === 'deleteChat') return new Error(reason);
      return input.type === 'chats' ? searchChats(input) : undefined;
    },
  });
  const action = await swipeOpen(page, 'chat-3', 'Nightly triage · Label new issues');
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await action.click();
  await expect
    .poll(() => messages)
    .toEqual([
      expect.stringContaining('Delete “Nightly triage · Label new issues”?'),
      `Couldn’t delete this chat\n\n${reason}`,
    ]);
});

test('no chats yet offers to start one', async ({ page }) => {
  await openApp(page, { data: { chats: { items: [], hasMore: false } } });
  await openHistory(page);
  await expect(page.getByText('No chats yet')).toBeVisible();
  await page.screenshot({ path: 'test-results/chats-empty-dark.png' });
  await page.getByRole('button', { name: 'Start a chat', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Project: / })).toBeVisible();
});

test('offline keeps the last list and says so', async ({ page }) => {
  const state = await openChats(page);
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  state.offline = true;
  await expect(
    page.getByTestId('history-panel').getByText('Can’t reach your Mac', { exact: true }),
  ).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  await page.screenshot({ path: 'test-results/chats-offline-dark.png' });
});

test('light appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openChats(page);
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  await page.screenshot({ path: 'test-results/chats-list-light.png' });
});
