import { openHistory } from './fixtures/navigation';
import { expect, test, type Page } from '@playwright/test';
import { openApp, type AppState } from './fixtures/app';
import { NOW, overviewFixture } from './fixtures/data';

const messageBox = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const send = (page: Page) => page.getByRole('button', { name: 'Send message', exact: true });
const created = { chatId: 'chat-new', subChatId: 'sub-new' };

async function openNewChat(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, { ...options, data: { createChat: created, ...options.data } });
  await expect(messageBox(page)).toBeVisible();
  return state;
}

/** Opens the picker from the project control, whatever it currently names, and picks `name`. */
async function pickProject(page: Page, name: string) {
  await page.getByRole('button', { name: /^Project: / }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Project: ${name}` })).toBeVisible();
}

/** Opens one of the message box's menus and picks an option. */
async function pick(page: Page, menu: string | RegExp, option: string) {
  await page.getByRole('button', { name: menu }).click();
  await page.getByRole('radio', { name: option, exact: true }).click();
}

const mutations = (state: AppState) =>
  state.requests.filter((input) =>
    ['createChat', 'sendMessage', 'deleteChat'].includes(input.type),
  );

test('a new chat is a blank conversation whose first message starts it', async ({ page }) => {
  const state = await openNewChat(page);
  // The same message box as any chat, not a sheet: nothing to cancel, nothing made yet.
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(messageBox(page)).not.toBeFocused();
  // Nothing remembered yet: the most recently active project is already chosen.
  await expect(page.getByRole('button', { name: 'Project: frink' })).toBeVisible();
  await expect(page.getByText('Worktree: a separate copy, safe to experiment.')).toBeVisible();
  await expect(send(page)).toBeDisabled();
  await messageBox(page).fill('Tighten the hero copy on the pricing page');

  await pickProject(page, 'marketing-site');
  await pick(page, 'Work in: Worktree', 'Local');
  await expect(page.getByText('Local: works directly in your project folder.')).toBeVisible();
  await pick(page, 'Mode: Agent', 'Plan');
  await expect(page.getByRole('button', { name: 'Mode: Plan' })).toBeVisible();
  expect(mutations(state)).toEqual([]);

  await send(page).click();
  await expect.poll(() => mutations(state).length).toBe(2);
  const [create, first] = mutations(state);
  expect(create).toEqual({
    type: 'createChat',
    projectId: 'project-2',
    useWorktree: false,
    mode: 'plan',
  });
  expect(first).toMatchObject({
    type: 'sendMessage',
    ...created,
    text: 'Tighten the hero copy on the pricing page',
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  // The blank page gives way to the chat it started.
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
});

test('the model is chosen in the message box before the first message', async ({ page }) => {
  const state = await openNewChat(page);
  // The model list belongs to a chat, so asking for it makes the chat; then the menus are live.
  await page.getByRole('button', { name: 'Choose model' }).click();
  await pick(page, /^Model: /, 'Opus 4.8');
  await expect(page.getByRole('button', { name: 'Model: Opus 4.8' })).toBeVisible();
  expect(state.requests.filter((input) => input.type === 'updateComposer')).toEqual([
    expect.objectContaining(created),
  ]);

  await messageBox(page).fill('Profile the cold start');
  await send(page).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  // One chat, made once, and kept because it was used.
  expect(mutations(state).map((input) => input.type)).toEqual(['createChat', 'sendMessage']);
});

test("a new chat offers no account choice: it runs on the project's account", async ({ page }) => {
  const state = await openNewChat(page);
  await page.getByRole('button', { name: 'Choose model' }).click();
  await pick(page, /^Model: /, 'More settings…');
  await expect(page.getByRole('switch', { name: 'Auto Mode', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Personal', exact: true })).toHaveCount(0);
  expect(state.requests.filter((input) => input.type === 'setAccount')).toEqual([]);
});

test('looking at the models and leaving does not strand an empty chat', async ({ page }) => {
  const state = await openNewChat(page);
  await page.getByRole('button', { name: 'Choose model' }).click();
  await expect(page.getByRole('button', { name: /^Model: / })).toBeVisible();
  await openHistory(page);
  await page.getByTestId('chat-row-chat-1').click();
  await expect
    .poll(() => mutations(state))
    .toEqual([
      expect.objectContaining({ type: 'createChat' }),
      { type: 'deleteChat', chatId: created.chatId },
    ]);
});

test('changing the project after looking at the models starts over in the new project', async ({
  page,
}) => {
  const state = await openNewChat(page);
  await page.getByRole('button', { name: 'Choose model' }).click();
  await expect(page.getByRole('button', { name: /^Model: / })).toBeVisible();
  await pickProject(page, 'billing-api');
  // The chat made for the first project is removed; the next one is made where it was asked for.
  await messageBox(page).fill('Retry failed webhooks');
  await send(page).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  expect(mutations(state).map((input) => [input.type, input.projectId ?? input.chatId])).toEqual([
    ['createChat', 'project-1'],
    ['deleteChat', created.chatId],
    ['createChat', 'project-3'],
    ['sendMessage', created.chatId],
  ]);
});

test('the next new chat starts where the last one did', async ({ page }) => {
  await openNewChat(page);
  await pickProject(page, 'billing-api');
  await pick(page, 'Work in: Worktree', 'Local');
  await pick(page, 'Mode: Agent', 'Plan');
  await messageBox(page).fill('Retry failed webhooks');
  await send(page).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();

  await page.goto('/');
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
  await expect(page.getByRole('button', { name: 'frink, chosen' })).toBeVisible();
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
  await send(page).click();
  await expect(page.getByText('Frink is busy. Try again.')).toBeVisible();
  await expect(messageBox(page)).toHaveValue('Bump the Electron version');
  // The message may have arrived, so the chat is kept and its project can no longer change.
  await expect(page.getByRole('button', { name: /^Project: / })).toBeDisabled();

  failSend = false;
  await send(page).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
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
  await openHistory(page);
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeDisabled();
});

test('with no projects on the Mac, the page says where to add one', async ({ page }) => {
  const state = await openNewChat(page, { data: { projects: [] } });
  await messageBox(page).fill('Set up CI');
  await expect(page.getByText('Add a project in Frink on your Mac to start a chat.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose model' })).toBeDisabled();
  await send(page).click();
  expect(mutations(state)).toEqual([]);
});

test('Leaving during chat creation removes the empty chat when creation finishes', async ({
  page,
}) => {
  const state = await openNewChat(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creating = false;
  await page.route('**/api', async (route) => {
    if (route.request().postDataJSON()?.type === 'createChat') {
      creating = true;
      await held;
    }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Choose model' }).click();
  await expect.poll(() => creating).toBe(true);
  await openHistory(page);
  await page.getByTestId('chat-row-chat-1').click();
  release();
  await expect
    .poll(() => mutations(state).map((input) => input.type))
    .toEqual(['createChat', 'deleteChat']);
});

test('picked files survive changing project and work location on a blank chat', async ({
  page,
}) => {
  let sequence = 0;
  const state = await openNewChat(page, {
    respond: (input) =>
      input.type === 'createChat'
        ? { chatId: `new-${++sequence}`, subChatId: `sub-${sequence}` }
        : undefined,
  });
  const targets: string[] = [];
  await page.route('**/api/attachments', async (route) => {
    targets.push(route.request().headers()['x-frink-chat']);
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('radio', { name: 'Files', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('keep me') });
  await expect(page.getByTestId('composer-attachment')).toContainText('notes.txt');
  await expect(send(page)).toBeEnabled();
  await expect.poll(() => targets).toEqual(['new-1']);

  await pickProject(page, 'marketing-site');
  await expect(page.getByTestId('composer-attachment')).toContainText('notes.txt');
  await expect.poll(() => targets).toEqual(['new-1', 'new-2']);
  await expect(send(page)).toBeEnabled();
  await pick(page, 'Work in: Worktree', 'Local');
  await expect(page.getByTestId('composer-attachment')).toContainText('notes.txt');
  await expect.poll(() => targets).toEqual(['new-1', 'new-2', 'new-3']);
  await expect(send(page)).toBeEnabled();
  const uploaded = state.requests.findLastIndex((input) => String(input.type) === 'upload') + 1;

  await send(page).click();
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toBeVisible();
  expect(state.requests.filter((input) => input.type === 'createChat')).toEqual([
    { type: 'createChat', projectId: 'project-1', useWorktree: true, mode: 'agent' },
    { type: 'createChat', projectId: 'project-2', useWorktree: true, mode: 'agent' },
    { type: 'createChat', projectId: 'project-2', useWorktree: false, mode: 'agent' },
  ]);
  expect(
    state.requests.filter((input) => input.type === 'deleteChat').map((input) => input.chatId),
  ).toEqual(['new-1', 'new-2']);
  expect(state.requests.find((input) => input.type === 'sendMessage')).toMatchObject({
    chatId: 'new-3',
    subChatId: 'sub-3',
    text: '',
    attachments: [`att-${uploaded}`],
  });
});

test('picking multiple files prepares only one chat and sends every file to it', async ({
  page,
}) => {
  const state = await openNewChat(page);
  await page.route('**/api', async (route) => {
    if (route.request().postDataJSON()?.type === 'createChat')
      await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fallback();
  });
  const targets: string[] = [];
  await page.route('**/api/attachments', async (route) => {
    targets.push(route.request().headers()['x-frink-chat']);
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('radio', { name: 'Files', exact: true }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
    { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
  ]);
  await expect(page.getByTestId('composer-attachment')).toHaveCount(2);
  await expect(send(page)).toBeEnabled();
  expect(state.requests.filter((input) => input.type === 'createChat')).toHaveLength(1);
  expect(targets).toEqual([created.chatId, created.chatId]);
  await send(page).click();
  await expect
    .poll(() => state.requests.find((input) => input.type === 'sendMessage'))
    .toMatchObject({ ...created, attachments: [expect.any(String), expect.any(String)] });
});

test('a project-specific New chat replaces the previous project selection', async ({ page }) => {
  await openNewChat(page);
  await expect(page.getByRole('button', { name: 'Project: frink', exact: true })).toBeVisible();
  await openHistory(page);
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New chat in marketing-site', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Project: marketing-site', exact: true }),
  ).toBeVisible();
  await openHistory(page);
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New chat in frink', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Project: frink', exact: true })).toBeVisible();
});
