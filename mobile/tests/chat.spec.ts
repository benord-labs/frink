import { expect, test } from '@playwright/test';
import type { MobileQuestion } from '../../src/shared/types/remote/mobile';
import { openApp } from './fixtures/app';
import {
  conversation,
  messageBox,
  openChat,
  requestsOf,
  scrollTranscript,
} from './fixtures/chat';
import { overviewFixture } from './fixtures/data';

const send = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Send message', exact: true });
const longTranscript = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    text: `Update ${index}: checking the release and preparing the next step.`,
  }));

test.describe('reading a chat', () => {
  for (const scheme of ['dark', 'light'] as const)
    test(`an idle chat reads as a calm transcript (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openApp(page, { data: { chat: conversation() } });
      await openChat(page);
      await expect(page.getByTestId('chat-subtitle')).toHaveText('Chat · frink');
      await expect(page.getByText('Steered', { exact: true })).toBeVisible();
      await expect(
        page.getByText('Use the existing waitForFrame helper instead of a new one.'),
      ).toBeVisible();
      await expect(messageBox(page)).toHaveAttribute('placeholder', 'Message Frink');
      await page.screenshot({ path: `test-results/chat-idle-${scheme}.png` });
      // Tool steps collapse to one line per run and open to the step list.
      const run = page.getByRole('button', { name: 'Worked · 3 steps', exact: true });
      await run.click();
      await expect(run).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText('Searching the code', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    });

  test('the header and composer say what a running chat is doing', async ({ page }) => {
    await openApp(page, { data: { chat: conversation({}, 'running') } });
    await openChat(page);
    // Opened mid-turn: the phone never saw the start, so no made-up duration.
    await expect(page.getByTestId('chat-subtitle')).toHaveText('Chat · frink·Running');
    // The live state is in the header; the box itself only invites a steer.
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
    await expect(page.getByRole('button', { name: 'Working · Running a command', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
  });

  test('a chat parked on background work offers Stop and says sending waits', async ({ page }) => {
    await openApp(page, { data: { chat: conversation({}, 'background') } });
    await openChat(page);
    await expect(page.getByTestId('chat-subtitle')).toHaveText('Chat · frink·Background');
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Frink is waiting on background work');
    await messageBox(page).fill('Also check the staging logs');
    await expect(page.getByText('Kept until the background work finishes.')).toBeVisible();
    await expect(send(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await page.screenshot({ path: 'test-results/chat-background-dark.png' });
  });

  test('a failed response is shown in the conversation', async ({ page }) => {
    await openApp(page, {
      data: {
        chat: conversation({ error: 'The response failed. Check Frink on your Mac for details.' }),
      },
    });
    await openChat(page);
    await expect(
      page.getByText('The response failed. Check Frink on your Mac for details.'),
    ).toBeVisible();
  });

  test('an unreachable Mac keeps the transcript and says what happened', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    state.offline = true;
    await expect(page.getByText('Can’t reach your Mac')).toBeVisible();
    await expect(page.getByTestId('message-m1')).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-offline-dark.png' });
    state.offline = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Can’t reach your Mac')).toHaveCount(0);
  });

  test('rich replies render safely and fit a narrow phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const images: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example')) images.push(request.url());
    });
    await openApp(page, {
      data: {
        chat: conversation({
          messages: [
            {
              id: 'rich',
              role: 'assistant',
              text: '',
              parts: [
                {
                  type: 'text',
                  text: '## Checks\n\n| Environment | Deployment |\n| --- | --- |\n| Staging | Ready |\n\n```sh\ncurl https://staging.example.com/a/very/long/path/that/scrolls/inside/the/block\n```\n\nSee [the notes](https://example.com/release).\n\n![Pixel](https://untrusted.example/pixel.png)\n\n[Unsafe](javascript:alert%281%29)',
                },
                { type: 'tool', id: 'a', name: 'Release task', state: 'interrupted' },
              ],
            },
          ],
        }),
      },
    });
    await openChat(page);
    await expect(page.getByRole('heading', { name: 'Checks', exact: true })).toBeAttached();
    await expect(page.locator('table')).toBeAttached();
    await expect(page.getByRole('link', { name: 'the notes', exact: true })).toHaveAttribute(
      'href',
      'https://example.com/release',
    );
    await expect(page.getByRole('link', { name: 'Unsafe', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stopped · 1 step', exact: true })).toBeVisible();
    expect(
      await page
        .getByTestId('chat-transcript')
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(images).toEqual([]);
  });
});

test.describe('scrolling', () => {
  test('follows new messages without moving a reader of earlier ones', async ({ page }) => {
    const messages = longTranscript(30);
    const state = await openApp(page, { data: { chat: conversation({ messages }) } });
    await openChat(page);
    await expect(page.getByTestId('message-m29')).toBeInViewport();
    await scrollTranscript(page, 600);
    const latest = page.getByRole('button', { name: 'Latest', exact: true });
    await expect(latest).toBeVisible();
    state.data.chat = conversation({
      messages: [...messages, { id: 'newest', role: 'assistant', text: 'New while you read.' }],
    });
    await expect(page.getByTestId('message-newest')).toBeAttached();
    await expect(page.getByTestId('message-newest')).not.toBeInViewport();
    // Copy belongs to the newest reply only, so a long chat isn't a column of icons.
    await expect(page.getByRole('button', { name: 'Copy message', exact: true })).toHaveCount(1);
    await page.screenshot({ path: 'test-results/chat-latest-dark.png' });
    await latest.click();
    await expect(page.getByTestId('message-newest')).toBeInViewport();
  });

  test('loading earlier messages keeps the message being read in place', async ({ page }) => {
    await openApp(page, {
      data: { chat: conversation({ messages: longTranscript(20), hasMore: true }) },
      respond: (input) =>
        input.beforeMessageId
          ? conversation({
              messages: Array.from({ length: 8 }, (_, index) => ({
                id: `old${index}`,
                role: 'assistant',
                text: `Earlier ${index}: the plan before release.`,
              })),
            })
          : undefined,
    });
    await openChat(page);
    await expect(page.getByTestId('message-m19')).toBeInViewport();
    await scrollTranscript(page, 0);
    const first = page.getByTestId('message-m0');
    await expect(first).toBeInViewport();
    const before = (await first.boundingBox())!.y;
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(page.getByTestId('message-old0')).toBeAttached();
    await expect
      .poll(async () => Math.abs((await first.boundingBox())!.y - before))
      .toBeLessThan(5);
  });
});

test.describe('conversations in one chat', () => {
  const subChats = [
    { id: 'sub-1', name: 'Release', activity: 'idle' as const },
    { id: 'sub-2', name: 'Follow-up', activity: 'running' as const },
  ];

  test('each conversation keeps its own draft and the Latest control resets', async ({ page }) => {
    const primary = conversation({ subChats, messages: longTranscript(30) });
    const state = await openApp(page, { data: { chat: primary } });
    await openChat(page);
    await expect(page.getByTestId('message-m29')).toBeInViewport();
    await scrollTranscript(page, 600);
    await expect(page.getByRole('button', { name: 'Latest', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-tabs-dark.png' });
    await messageBox(page).fill('Release draft');
    state.data.chat = { ...primary, subChatId: 'sub-2', activity: 'running' };
    await page.getByRole('tab', { name: 'Follow-up', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Follow-up', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Latest', exact: true })).toHaveCount(0);
    await expect(messageBox(page)).toHaveValue('');
    state.data.chat = primary;
    await page.getByRole('tab', { name: 'Release', exact: true }).click();
    await expect(messageBox(page)).toHaveValue('Release draft');
  });

  test('a long chat keeps the offline banner and the tabs in sight', async ({ page }) => {
    const state = await openApp(page, {
      data: { chat: conversation({ subChats, messages: longTranscript(30) }) },
    });
    await openChat(page);
    await expect(page.getByTestId('message-m29')).toBeInViewport();
    state.offline = true;
    await expect(page.getByText('Can’t reach your Mac')).toBeInViewport();
    await expect(page.getByRole('tab', { name: 'Release', exact: true })).toBeInViewport();
    await expect(page.getByRole('tab', { name: 'Follow-up', exact: true })).toBeInViewport();
    // Following the newest message is unaffected: the banner pins above, not in, the transcript.
    await expect(page.getByTestId('message-m29')).toBeInViewport();
    await page.screenshot({ path: 'test-results/chat-offline-long-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: 'test-results/chat-offline-long-light.png' });
  });
});

test.describe('sending and steering', () => {
  test('a lost send keeps the draft and retries with the same request id', async ({ page }) => {
    let sends = 0;
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: (input) => {
        if (input.type === 'sendMessage' && ++sends === 1)
          return new Error(
            'Cannot reach your computer. If you sent an action, refresh before trying again; it may have reached your computer.',
          );
        return undefined;
      },
    });
    await openChat(page);
    await messageBox(page).fill('Please verify staging first.');
    await send(page).click();
    await expect(page.getByText(/it may have reached your computer/)).toBeVisible();
    await expect(messageBox(page)).toHaveValue('Please verify staging first.');
    await send(page).click();
    await expect(messageBox(page)).toHaveValue('');
    const [first, second] = requestsOf(state, 'sendMessage');
    expect(second.requestId).toBe(first.requestId);
  });

  test('typing while Frink works steers it, then clears the box', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    // Start a turn from the phone so the header can time it.
    await messageBox(page).fill('Fix the flaky test');
    state.data.chat = conversation({}, 'running');
    await send(page).click();
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
    await page.clock.fastForward(72_000);
    await expect(page.getByTestId('chat-subtitle')).toHaveText(/Chat · frink·Running 1m 1\ds/);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await messageBox(page).fill('Use the existing waitForFrame helper');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/chat-running-steer-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: 'test-results/chat-running-steer-light.png' });
    state.respond = (input) =>
      input.type === 'steerMessage' ? { outcome: 'delivered' } : undefined;
    await send(page).click();
    await expect(messageBox(page)).toHaveValue('');
    const [steer] = requestsOf(state, 'steerMessage');
    expect(steer).toEqual({
      type: 'steerMessage',
      chatId: 'chat-1',
      subChatId: 'sub-1',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      text: 'Use the existing waitForFrame helper',
    });
    expect(requestsOf(state, 'sendMessage')).toHaveLength(1);
  });

  test('a steer Frink can’t take stays in the box with an honest note', async ({ page }) => {
    const state = await openApp(page, {
      data: { chat: conversation({}, 'running') },
      respond: (input) =>
        input.type === 'steerMessage' ? { outcome: 'not-delivered' } : undefined,
    });
    await openChat(page);
    await messageBox(page).fill('Also update the changelog');
    await send(page).click();
    await expect(
      page.getByText('Frink can’t take this mid-step. It’s kept for when it finishes.'),
    ).toBeVisible();
    await expect(messageBox(page)).toHaveValue('Also update the changelog');
    await page.screenshot({ path: 'test-results/chat-steer-kept-dark.png' });
    // Nothing was sent, so trying again is a new request rather than a replay of the refusal.
    await send(page).click();
    await expect.poll(() => requestsOf(state, 'steerMessage').length).toBe(2);
    const [first, second] = requestsOf(state, 'steerMessage');
    expect(second.requestId).not.toBe(first.requestId);
    expect(requestsOf(state, 'sendMessage')).toHaveLength(0);
  });

  test('stopping an ordinary chat is one tap', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation({}, 'running') } });
    await openChat(page);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect
      .poll(() => requestsOf(state, 'stopChat'))
      .toEqual([{ type: 'stopChat', chatId: 'chat-1', subChatId: 'sub-1' }]);
  });

  test('stopping a Flow step asks first, because it ends the whole run', async ({ page }) => {
    const state = await openApp(page, {
      data: { chat: conversation({ kind: 'flow' }, 'running') },
    });
    await openChat(page);
    await expect(page.getByTestId('chat-subtitle')).toHaveText('Flow · frink·Running');
    const stop = page.getByRole('button', { name: 'Stop run', exact: true });
    await expect(stop).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-flow-running-dark.png' });
    const prompts: string[] = [];
    page.once('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await stop.click();
    await expect.poll(() => prompts).toEqual(['Stop run?\n\nStopping ends the whole Flow run.']);
    expect(requestsOf(state, 'stopChat')).toHaveLength(0);
    page.once('dialog', (dialog) => void dialog.accept());
    await stop.click();
    await expect.poll(() => requestsOf(state, 'stopChat').length).toBe(1);
  });

  test('a Mac that can’t run chats disables sending and says why', async ({ page }) => {
    await openApp(page, {
      data: { chat: conversation(), overview: { ...overviewFixture(), executionReady: false } },
    });
    await openChat(page);
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Open Frink on your Mac to chat');
    await expect(messageBox(page)).not.toBeEditable();
    await expect(send(page)).toBeDisabled();
    await expect(page.getByTestId('message-m2')).toBeVisible();
  });
});

test.describe('questions and permissions', () => {
  const question: MobileQuestion = {
    id: 'q1',
    source: 'live',
    chatId: 'chat-1',
    subChatId: 'sub-1',
    title: 'Why is the build slow on CI?',
    questions: [
      {
        question: 'Should I switch the CI cache to the lockfile hash?',
        header: 'CI cache',
        multiSelect: false,
        options: [
          { label: 'Yes, switch it', description: 'Rebuilds the cache when dependencies change' },
          { label: 'Keep the current key', description: 'No change to CI' },
        ],
      },
    ],
  };

  for (const scheme of ['dark', 'light'] as const)
    test(`a question is answered inline (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const state = await openApp(page, {
        data: { chat: conversation({ questions: [question] }) },
      });
      await openChat(page, { id: 'chat-1', decisionTarget: { type: 'question', id: 'q1' } });
      const card = page.getByTestId('decision-question-q1');
      // Opening from the Queue lands on the question itself, not the top of the transcript.
      await expect(card).toBeInViewport({ ratio: 0.95 });
      // An idle chat with an open question hides the composer: answering is the next step.
      await expect(messageBox(page)).toHaveCount(0);
      await card.getByRole('radio').filter({ hasText: 'Yes, switch it' }).click();
      await page.screenshot({ path: `test-results/chat-question-${scheme}.png` });
      state.data.chat = conversation();
      await card.getByRole('button', { name: 'Send answer', exact: true }).click();
      await expect(card).toHaveCount(0);
      expect(requestsOf(state, 'answerQuestion')[0]).toMatchObject({
        id: 'q1',
        answers: { 'Should I switch the CI cache to the lockfile hash?': 'Yes, switch it' },
      });
      await expect(messageBox(page)).toBeVisible();
    });

  test('a prose question keeps an unfinished reply across visits', async ({ page }) => {
    const prose = {
      ...question,
      source: 'parked' as const,
      questions: [],
      title: 'Which environment?',
    };
    const state = await openApp(page, { data: { chat: conversation({ questions: [prose] }) } });
    await openChat(page, { id: 'chat-1', decisionTarget: { type: 'question', id: 'q1' } });
    const reply = page.getByRole('textbox', { name: 'Reply to your agent', exact: true });
    await reply.fill('Run the staging smoke tests.');
    await page.getByRole('link', { name: 'Tabs, back', exact: true }).click();
    await openChat(page, { id: 'chat-1', decisionTarget: { type: 'question', id: 'q1' } });
    await expect(reply).toHaveValue('Run the staging smoke tests.');
    await page.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect
      .poll(() => requestsOf(state, 'answerQuestion')[0]?.answers)
      .toEqual({
        reply: 'Run the staging smoke tests.',
      });
  });

  test('a question already answered on the Mac says so', async ({ page }) => {
    await openApp(page, { data: { chat: conversation() } });
    await openChat(page, { id: 'chat-1', decisionTarget: { type: 'question', id: 'gone' } });
    await expect(
      page.getByText('This was already answered on your Mac. The chat is up to date.'),
    ).toBeVisible();
  });

  test('a permission is allowed once from the phone', async ({ page }) => {
    const state = await openApp(page, {
      data: {
        chat: conversation({
          permissions: [
            {
              requestId: 'perm-1',
              chatId: 'chat-1',
              subChatId: 'sub-1',
              title: 'Run database migration',
              description: 'bun run db:migrate --env staging',
              supported: true,
            },
          ],
        }),
      },
    });
    await openChat(page);
    await page.screenshot({ path: 'test-results/chat-permission-dark.png' });
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect
      .poll(() => requestsOf(state, 'respondPermission'))
      .toEqual([
        {
          type: 'respondPermission',
          requestId: 'perm-1',
          chatId: 'chat-1',
          subChatId: 'sub-1',
          approved: true,
        },
      ]);
  });
});

test('deleting a chat from its header asks first, then leaves the chat', async ({ page }) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  const prompts: string[] = [];
  page.once('dialog', (dialog) => {
    prompts.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => prompts)
    .toEqual([expect.stringContaining('Delete “Fix flaky checkout tests”?')]);
  expect(requestsOf(state, 'deleteChat')).toHaveLength(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => requestsOf(state, 'deleteChat'))
    .toEqual([{ type: 'deleteChat', chatId: 'chat-1' }]);
  await expect(page.getByTestId('chat-transcript')).toHaveCount(0);
});
