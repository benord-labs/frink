import { expect, test, type Page } from '@playwright/test';
import type {
  MobileChatDetail,
  MobileChatOp,
  MobileMessage,
  MobileQuestion,
} from '@frink/shared/types/remote/mobile';
import { UNKNOWN_REQUEST, UNREACHABLE, held, openApp, type AppState } from './fixtures/app';
import {
  changeChat,
  conversation,
  messageBox,
  openChat,
  requestsOf,
  scrollTranscript,
} from './fixtures/chat';
import { overviewFixture } from './fixtures/data';
import { openDestination } from './fixtures/navigation';

const send = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'Send message', exact: true });
type Input = Parameters<NonNullable<AppState['respond']>>[0];
/** Answers a send as the Mac does: the message is saved under its request id. */
function saveSent(state: AppState, input: Input) {
  // SAFETY: every test that saves a send opened the app with a chat.
  const chat = state.data.chat as MobileChatDetail;
  const message = { id: String(input.requestId), role: 'user', text: String(input.text) };
  state.data.chat = { ...chat, messages: [...chat.messages, message] };
  return { ok: true };
}
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
      await expect(page.getByTestId('chat-subtitle')).toHaveText('frink');
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
    await expect(page.getByTestId('chat-subtitle')).toHaveText('frink·Running');
    // The live state is in the header; the box itself only invites a steer.
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
    await expect(
      page.getByRole('button', { name: 'Working · Running a command', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
  });

  test('a message sent during a background wait takes it over, as on desktop', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation({}, 'background') } });
    await openChat(page);
    await expect(page.getByTestId('chat-subtitle')).toHaveText('frink·Background');
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Message Frink while it waits');
    // Empty, the box stops the work; typing turns Stop into Send beside the same attach button.
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-background-empty-dark.png' });
    await messageBox(page).fill('Also check the staging logs');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-background-typed-dark.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: 'test-results/chat-background-typed-light.png' });
    state.data.chat = conversation({}, 'running');
    await send(page).click();
    await expect
      .poll(() => requestsOf(state, 'sendMessage'))
      .toEqual([
        expect.objectContaining({
          chatId: 'chat-1',
          subChatId: 'sub-1',
          text: 'Also check the staging logs',
        }),
      ]);
    expect(requestsOf(state, 'steerMessage')).toHaveLength(0);
    await expect(messageBox(page)).toHaveValue('');
    await expect(page.getByTestId('chat-subtitle')).toHaveText('frink·Running');
  });

  test('a Flow step waiting on background work only offers Stop run', async ({ page }) => {
    await openApp(page, { data: { chat: conversation({ kind: 'flow' }, 'background') } });
    await openChat(page);
    await expect(page.getByTestId('chat-subtitle')).toHaveText('Flow · frink·Background');
    await expect(messageBox(page)).toHaveAttribute(
      'placeholder',
      'Frink is waiting on background work',
    );
    await messageBox(page).fill('Also check the staging logs');
    await expect(page.getByText('Kept until the background work finishes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
    await expect(send(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/chat-flow-background-dark.png' });
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
    await expect(page.getByTestId('message-m1')).toBeVisible();
    state.offline = true;
    await expect(page.getByText('Can’t reach your Mac', { exact: true })).toBeVisible();
    await expect(page.getByTestId('message-m1')).toBeVisible();
    await page.screenshot({ path: 'test-results/chat-offline-dark.png' });
    state.offline = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Can’t reach your Mac', { exact: true })).toHaveCount(0);
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

  test('files, folders and selections read as the desktop’s badges', async ({ page }) => {
    const sentence = 'Why does checkout.spec.ts wait? Compare frames.ts in helpers';
    await openApp(page, {
      data: {
        chat: conversation({
          messages: [
            {
              id: 'mine',
              role: 'user',
              text: sentence,
              parts: [
                { type: 'attachment', kind: 'file', name: 'checkout.spec.ts', detail: 'L12-13' },
                { type: 'attachment', kind: 'text', name: 'waits for the Pay button' },
                {
                  type: 'text',
                  text: sentence,
                  runs: [
                    { text: 'Why does ' },
                    { text: 'checkout.spec.ts', mention: 'file' },
                    { text: ' wait? Compare ' },
                    { text: 'frames.ts', mention: 'file' },
                    { text: ' in ' },
                    { text: 'helpers', mention: 'folder' },
                  ],
                },
              ],
            },
            {
              id: 'reply',
              role: 'assistant',
              text: 'The wait uses a fixed timeout.',
              parts: [
                { type: 'text', text: 'The wait uses a fixed timeout.' },
                {
                  type: 'steer',
                  text: 'Use frames.ts instead',
                  runs: [
                    { text: 'Use ' },
                    { text: 'frames.ts', mention: 'file' },
                    { text: ' instead' },
                  ],
                },
              ],
            },
          ],
        }),
      },
    });
    await openChat(page);
    const mine = page.getByTestId('message-mine');
    await expect(mine.getByLabel('File: checkout.spec.ts L12-13')).toBeVisible();
    await expect(mine.getByLabel('Selected text: waits for the Pay button')).toBeVisible();
    // Badges sit inside the sentence, which still reads whole to assistive tech.
    await expect(mine.getByLabel(sentence)).toBeVisible();
    await expect(mine.getByText('helpers', { exact: true })).toBeVisible();
    await expect(page.getByText('@[')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/chat-mention-badges.png' });
  });
});

test.describe('live updates', () => {
  const appendToReply = (text: string): MobileChatOp => ({
    op: 'append',
    messageId: 'm2',
    partIndex: 3,
    text,
  });
  /** Opens the chat once the computer has answered its live watch; like the desktop, the first
   *  event waits a moment after that answer. */
  async function openLiveChat(page: Page, state: AppState) {
    await openChat(page);
    await expect.poll(() => state.watches.length).toBe(1);
    await page.waitForTimeout(250);
  }

  test('a pushed reply shows at once, without asking for the chat again', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation({}, 'running') } });
    await openLiveChat(page, state);
    const reads = requestsOf(state, 'chat').length;
    expect(state.push([appendToReply(' The suite now passes 20 times in a row.')])).toBe(true);
    await expect(page.getByText(/The suite now passes 20 times in a row\./)).toBeVisible();
    expect(requestsOf(state, 'chat')).toHaveLength(reads);
    expect(requestsOf(state, 'watchChat')).toHaveLength(1);
  });

  test('during a steady stream, a change the computer did not push shows within 15 s', async ({
    page,
  }) => {
    const running = conversation({}, 'running');
    const state = await openApp(page, { data: { chat: running } });
    await openLiveChat(page, state);
    const reads = requestsOf(state, 'chat').length;
    state.data.chat = { ...running, chat: { ...running.chat, name: 'Renamed on the computer' } };
    for (let second = 0; second < 16; second++) {
      state.push([appendToReply('.')]);
      await page.clock.runFor(1000);
    }
    await expect(page.getByText('Renamed on the computer').first()).toBeVisible();
    expect(requestsOf(state, 'chat')).toHaveLength(reads);
    expect(requestsOf(state, 'watchChat')).toHaveLength(2);
  });

  test('a skipped event asks for a fresh copy exactly once', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation({}, 'running') } });
    await openLiveChat(page, state);
    const [sub] = state.watches;
    expect(state.push([appendToReply(' Skipped ahead.')], { seq: 5 })).toBe(true);
    await expect.poll(() => requestsOf(state, 'watchChat').length).toBe(2);
    expect(requestsOf(state, 'unwatchChat')).toEqual([{ type: 'unwatchChat', sub }]);
    await expect(page.getByText(/Skipped ahead/)).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(requestsOf(state, 'watchChat')).toHaveLength(2);
  });

  test('an older computer that cannot push keeps the chat on quick polls, with no error', async ({
    page,
  }) => {
    const state = await openApp(page, {
      data: { chat: conversation({}, 'running') },
      respond: (input) => (input.type === 'watchChat' ? UNKNOWN_REQUEST : undefined),
    });
    await openChat(page);
    await expect.poll(() => requestsOf(state, 'watchChat').length).toBe(1);
    const reads = requestsOf(state, 'chat').length;
    await page.clock.runFor(4500);
    await expect.poll(() => requestsOf(state, 'chat').length).toBeGreaterThan(reads);
    await expect(page.getByText(/Invalid request/)).toHaveCount(0);
    await expect(page.getByTestId('message-m2')).toBeVisible();
  });

  test('a message sent from the phone settles when its saved copy is pushed', async ({ page }) => {
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: (input) => (input.type === 'sendMessage' ? { ok: true } : undefined),
    });
    await openLiveChat(page, state);
    await messageBox(page).fill('Run it once more on CI');
    await send(page).click();
    await expect.poll(() => requestsOf(state, 'sendMessage')).toHaveLength(1);
    const [sent] = requestsOf(state, 'sendMessage');
    await expect(page.getByText('Sending…', { exact: true })).toBeVisible();
    // A send's follow-up read is a fresh copy through the stream, on a new watch.
    await expect.poll(() => state.watches.length).toBe(2);
    const saved: MobileMessage = {
      id: String(sent.requestId),
      role: 'user',
      text: 'Run it once more on CI',
    };
    expect(state.push([{ op: 'upsert', message: saved }])).toBe(true);
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Run it once more on CI', { exact: true })).toHaveCount(1);
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
    const newest: MobileMessage = { id: 'newest', role: 'assistant', text: 'New while you read.' };
    state.data.chat = conversation({ messages: [...messages, newest] });
    // Sent once, as soon as the chat's live watch is open.
    await expect.poll(() => state.push([{ op: 'upsert', message: newest }])).toBe(true);
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
  test('a sent message shows at once and the box stays free while the Mac answers', async ({
    page,
  }) => {
    const answer = held();
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: async (input) => {
        if (input.type !== 'sendMessage') return undefined;
        await answer.promise;
        return saveSent(state, input);
      },
    });
    await openChat(page);
    await messageBox(page).fill('Please verify staging first.');
    await send(page).click();
    await expect(page.getByText('Please verify staging first.')).toBeVisible();
    await expect(page.getByText('Sending…', { exact: true })).toBeVisible();
    await expect(messageBox(page)).toHaveValue('');
    await expect(messageBox(page)).toBeEditable();
    await messageBox(page).fill('Then the changelog');
    await page.screenshot({ path: 'test-results/chat-sending-dark.png' });
    answer.release();
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Please verify staging first.')).toHaveCount(1);
    await expect(messageBox(page)).toHaveValue('Then the changelog');
  });

  test('an unreachable send is tried once more under the same request id', async ({ page }) => {
    let sends = 0;
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: (input) => {
        if (input.type !== 'sendMessage') return undefined;
        return ++sends === 1 ? UNREACHABLE : saveSent(state, input);
      },
    });
    await openChat(page);
    await messageBox(page).fill('Please verify staging first.');
    await send(page).click();
    await expect.poll(() => requestsOf(state, 'sendMessage').length).toBe(2);
    const [first, second] = requestsOf(state, 'sendMessage');
    expect(second.requestId).toBe(first.requestId);
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Please verify staging first.')).toHaveCount(1);
  });

  test('a send the Mac refuses says so, and a tap retries it under the same id', async ({
    page,
  }) => {
    let sends = 0;
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: (input) => {
        if (input.type !== 'sendMessage') return undefined;
        return ++sends === 1 ? new Error('Frink is busy. Try again.') : saveSent(state, input);
      },
    });
    await openChat(page);
    await messageBox(page).fill('Please verify staging first.');
    await send(page).click();
    const retry = page.getByRole('button', { name: /Not delivered · Tap to retry/ });
    await expect(retry).toBeVisible();
    await expect(page.getByText('Frink is busy. Try again.')).toBeVisible();
    await expect(messageBox(page)).toHaveValue('');
    await page.screenshot({ path: 'test-results/chat-not-delivered-dark.png' });
    // A retry stays a send under its id even once a turn runs, so a saved copy is never steered in.
    changeChat(state, conversation({}, 'running'));
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('Please verify staging first.')).toHaveCount(1);
    const [first, second] = requestsOf(state, 'sendMessage');
    expect(second.requestId).toBe(first.requestId);
    expect(requestsOf(state, 'steerMessage')).toHaveLength(0);
  });

  test('a second message sent before the first shows up steers instead', async ({ page }) => {
    const answer = held();
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: async (input) => {
        if (input.type === 'steerMessage') {
          // The first message's turn is running, with the steer's note in its reply.
          const parts = [{ type: 'steer', text: String(input.text) }];
          const reply = { id: 'reply', role: 'assistant', text: '', parts };
          const running = conversation({}, 'running');
          state.data.chat = { ...running, messages: [...running.messages, reply] };
          return { outcome: 'delivered' };
        }
        if (input.type !== 'sendMessage') return undefined;
        await answer.promise;
        return saveSent(state, input);
      },
    });
    await openChat(page);
    await messageBox(page).fill('Fix the flaky test');
    await send(page).click();
    await messageBox(page).fill('Use the existing waitForFrame helper');
    await send(page).click();
    await expect
      .poll(() => requestsOf(state, 'steerMessage'))
      .toEqual([expect.objectContaining({ text: 'Use the existing waitForFrame helper' })]);
    answer.release();
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Frink reads this at its next step')).toHaveCount(0);
    expect(requestsOf(state, 'sendMessage')).toHaveLength(1);
    await expect(page.getByText(/Not delivered/)).toHaveCount(0);
  });

  test('typing while Frink works steers it, then clears the box', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation() } });
    await openChat(page);
    // Start a turn from the phone so the header can time it.
    await messageBox(page).fill('Fix the flaky test');
    state.data.chat = conversation({}, 'running');
    state.respond = (input) => (input.type === 'sendMessage' ? saveSent(state, input) : undefined);
    await send(page).click();
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Guide Frink while it works');
    await page.clock.fastForward(72_000);
    await expect(page.getByTestId('chat-subtitle')).toHaveText(/frink·Running 1m 1\ds/);
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
    // Taken, but the agent hasn't reached its next step: reads without its note keep the bubble.
    const waiting = page.getByText('Frink reads this at its next step', { exact: true });
    await expect(waiting).toBeVisible();
    const copies = requestsOf(state, 'watchChat').length;
    await page.clock.fastForward(16_000);
    await expect.poll(() => requestsOf(state, 'watchChat').length).toBeGreaterThan(copies);
    await expect(waiting).toBeVisible();
    // The computer shows the steer inside the running reply, never as a message of its own.
    // SAFETY: this test opened the app with a chat.
    const chat = state.data.chat as MobileChatDetail;
    const reply: MobileMessage = {
      id: 'steered-reply',
      role: 'assistant',
      text: '',
      parts: [{ type: 'steer', text: 'Use the existing waitForFrame helper' }],
    };
    changeChat(state, { ...chat, messages: [...chat.messages, reply] });
    await expect(waiting).toHaveCount(0);
    await expect(page.getByText('Sending…', { exact: true })).toHaveCount(0);
    await expect(
      page.getByText('Use the existing waitForFrame helper', { exact: true }),
    ).toHaveCount(1);
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

  test('a steer Frink can’t take stays as not delivered, and a tap sends it again', async ({
    page,
  }) => {
    const state = await openApp(page, {
      data: { chat: conversation({}, 'running') },
      respond: (input) => {
        if (input.type === 'steerMessage') return { outcome: 'not-delivered' };
        return input.type === 'sendMessage' ? saveSent(state, input) : undefined;
      },
    });
    await openChat(page);
    await messageBox(page).fill('Also update the changelog');
    await send(page).click();
    const retry = page.getByRole('button', { name: /Not delivered · Tap to retry/ });
    await expect(retry).toBeVisible();
    await expect(
      page.getByText('Frink couldn’t take this mid-step, so nothing was sent.'),
    ).toBeVisible();
    await expect(messageBox(page)).toHaveValue('');
    await page.screenshot({ path: 'test-results/chat-steer-kept-dark.png' });
    // Still running: asked again as a steer, under a new id since the refusal is remembered by id.
    await retry.click();
    await expect.poll(() => requestsOf(state, 'steerMessage').length).toBe(2);
    await expect(retry).toBeVisible();
    // Once the chat is idle the same text starts a turn instead.
    changeChat(state, conversation());
    await expect(messageBox(page)).toHaveAttribute('placeholder', 'Message Frink');
    await retry.click();
    await expect(retry).toHaveCount(0);
    const [first, second] = requestsOf(state, 'steerMessage');
    const sends = requestsOf(state, 'sendMessage');
    expect(sends).toEqual([expect.objectContaining({ text: 'Also update the changelog' })]);
    expect(new Set([first.requestId, second.requestId, sends[0].requestId]).size).toBe(3);
    await expect(page.getByText('Also update the changelog')).toHaveCount(1);
  });

  test('a failed message is discarded with press and hold, after a confirm', async ({ page }) => {
    await openApp(page, {
      data: { chat: conversation() },
      respond: (input) =>
        input.type === 'sendMessage' ? new Error('Frink is busy. Try again.') : undefined,
    });
    await openChat(page);
    await messageBox(page).fill('Please verify staging first.');
    await send(page).click();
    const retry = page.getByRole('button', { name: /Not delivered · Tap to retry/ });
    await expect(retry).toBeVisible();
    const prompts: string[] = [];
    page.once('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await retry.click({ delay: 800 });
    await expect.poll(() => prompts).toEqual([expect.stringContaining('Discard this message?')]);
    await expect(retry).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await retry.click({ delay: 800 });
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('Please verify staging first.')).toHaveCount(0);
    await expect(messageBox(page)).toHaveValue('');
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

/** Opens the actual Queue decision, including a stale row whose question was already answered. */
async function openQuestion(page: Page, state: AppState, question: MobileQuestion) {
  state.data.overview = { ...overviewFixture(), queue: [], questions: [question], permissions: [] };
  await page.clock.runFor(3500);
  await openDestination(page, 'Queue');
  await page.getByTestId(`queue-row-question:${question.id}`).click();
  await expect(page.getByTestId('chat-transcript').filter({ visible: true })).toBeVisible();
}

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
      await openQuestion(page, state, question);
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
    await openQuestion(page, state, question);
    const reply = page.getByRole('textbox', { name: 'Reply to your agent', exact: true });
    await reply.fill('Run the staging smoke tests.');
    await page.getByRole('link', { name: /back/i }).click();
    await openQuestion(page, state, question);
    await expect(reply).toHaveValue('Run the staging smoke tests.');
    await page.getByRole('button', { name: 'Send answer', exact: true }).click();
    await expect
      .poll(() => requestsOf(state, 'answerQuestion')[0]?.answers)
      .toEqual({
        reply: 'Run the staging smoke tests.',
      });
  });

  test('a question already answered on the Mac says so', async ({ page }) => {
    const state = await openApp(page, { data: { chat: conversation() } });
    await openQuestion(page, state, { ...question, id: 'gone' });
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
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => prompts)
    .toEqual([expect.stringContaining('Delete “Fix flaky checkout tests”?')]);
  expect(requestsOf(state, 'deleteChat')).toHaveLength(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Chat options', exact: true }).click();
  await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect
    .poll(() => requestsOf(state, 'deleteChat'))
    .toEqual([{ type: 'deleteChat', chatId: 'chat-1' }]);
  await expect(page.getByRole('button', { name: 'Chat options', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
});
