import { expect, test, type Page } from '@playwright/test';
import { openApp, type AppState } from './fixtures/app';
import { NOW, overviewFixture } from './fixtures/data';

const messageBox = (page: Page) => page.getByRole('textbox', { name: 'New chat message' });
const created = { chatId: 'chat-new', subChatId: 'sub-new' };

async function openNewChat(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, { ...options, data: { createChat: created, ...options.data } });
  await page.getByTestId('tab-chats').click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(messageBox(page)).toBeVisible();
  return state;
}

/** Opens the picker from the project chip, whatever it currently names, and picks `name`. */
async function pickProject(page: Page, name: string) {
  await page.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible();
}

const mutations = (state: AppState) =>
  state.requests.filter((input) => input.type === 'createChat' || input.type === 'sendMessage');

test('a first message starts a chat with the chosen project, location and mode', async ({
  page,
}) => {
  const state = await openNewChat(page);
  await expect(messageBox(page)).toBeFocused();
  // Nothing remembered yet: the most recently active project is already chosen.
  await expect(page.getByRole('button', { name: 'Project: frink' })).toBeVisible();
  await expect(page.getByText('Worktree: a separate copy, safe to experiment.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start chat' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/new-chat-open-dark.png' });
  await messageBox(page).fill('Tighten the hero copy on the pricing page');
  await expect(page.getByRole('button', { name: 'Start chat' })).toBeEnabled();

  await pickProject(page, 'marketing-site');

  await page.getByRole('button', { name: 'Work in: Worktree' }).click();
  await expect(page.getByText('Local: works directly in your project folder.')).toBeVisible();
  await page.getByRole('button', { name: 'Mode: Agent' }).click();
  await expect(page.getByRole('button', { name: 'Mode: Plan' })).toBeVisible();
  await page.screenshot({ path: 'test-results/new-chat-ready-dark.png' });

  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect.poll(() => mutations(state).length).toBe(2);
  const [create, send] = mutations(state);
  expect(create).toEqual({
    type: 'createChat',
    projectId: 'project-2',
    useWorktree: false,
    mode: 'plan',
  });
  expect(send).toMatchObject({
    type: 'sendMessage',
    ...created,
    text: 'Tighten the hero copy on the pricing page',
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  // The sheet gives way to the new chat.
  await expect(messageBox(page)).toHaveCount(0);
});

test('the next new chat starts where the last one did', async ({ page }) => {
  await openNewChat(page);
  await pickProject(page, 'billing-api');
  await page.getByRole('button', { name: 'Work in: Worktree' }).click();
  await page.getByRole('button', { name: 'Mode: Agent' }).click();
  await messageBox(page).fill('Retry failed webhooks');
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(messageBox(page)).toHaveCount(0);

  await page.goto('/');
  await page.getByTestId('tab-chats').click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: billing-api' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Work in: Local' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mode: Plan' })).toBeVisible();
  await expect(messageBox(page)).toHaveValue('');
});

test('the project picker lists every project and searches a long list', async ({ page }) => {
  const many = ['frink', 'marketing-site', 'billing-api', 'design-system'];
  many.push('docs', 'mobile', 'relay', 'infra');
  await openNewChat(page, {
    data: {
      projects: many.map((name, index) => ({
        id: `project-${index + 1}`,
        name,
        lastActiveAt: new Date(NOW - index * 3_600_000).toISOString(),
      })),
    },
  });
  await page.getByRole('button', { name: 'Project: frink' }).click();
  // The sheet's own header becomes the picker's: one title, one way back, no Send.
  await expect(page.getByText('Choose a project', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start chat' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'frink, chosen' })).toBeVisible();
  await page.screenshot({ path: 'test-results/new-chat-picker-dark.png' });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: frink' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Project: frink' }).click();
  await page.getByRole('textbox', { name: 'Search projects' }).fill('rel');
  await expect(page.getByRole('button', { name: 'relay', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'frink', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'relay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: relay' })).toBeVisible();
  await expect(messageBox(page)).toBeVisible();
});

test('a failed first message keeps the text and reuses the chat on retry', async ({ page }) => {
  let failSend = true;
  const state = await openNewChat(page, {
    respond: (input) => {
      if (input.type === 'sendMessage' && failSend) return new Error('Frink is busy. Try again.');
      return undefined;
    },
  });
  await messageBox(page).fill('Bump the Electron version');
  await page.getByRole('button', { name: 'Start chat' }).click();
  // A plain cause and fix first, then what the Mac said.
  await expect(page.getByText('Your chat was made, but the first message didn’t send.')).toBeVisible();
  await expect(page.getByText('Frink is busy. Try again.')).toBeVisible();
  await expect(messageBox(page)).toHaveValue('Bump the Electron version');
  await expect(page.getByRole('button', { name: 'Open the new chat' })).toBeVisible();
  await page.screenshot({ path: 'test-results/new-chat-error-dark.png' });

  failSend = false;
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(messageBox(page)).toHaveCount(0);
  expect(mutations(state).map((input) => input.type)).toEqual([
    'createChat',
    'sendMessage',
    'sendMessage',
  ]);
  // Same text, same request ID: the computer can tell a retry from a second message.
  const [, first, retry] = mutations(state);
  expect(retry.requestId).toBe(first.requestId);
});

test('without Frink running on the Mac, a chat cannot start', async ({ page }) => {
  await openApp(page, { data: { overview: { ...overviewFixture(), executionReady: false } } });
  await page.getByTestId('tab-chats').click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeDisabled();
  await page.screenshot({ path: 'test-results/new-chat-not-ready-dark.png' });
});

test('light appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openNewChat(page);
  await messageBox(page).fill('Write release notes for 0.0.13');
  await page.screenshot({ path: 'test-results/new-chat-ready-light.png' });
});

test('with no projects on the Mac, the sheet says where to add one', async ({ page }) => {
  await openNewChat(page, { data: { projects: [] } });
  await messageBox(page).fill('Set up CI');
  await expect(page.getByText('Add a project in Frink on your Mac to start a chat.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start chat' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/new-chat-no-projects-dark.png' });
});
