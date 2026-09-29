import { expect, test, type Page } from '@playwright/test';
import type { MobileChatDetail, MobileQuestion } from '../../src/shared/types/remote/mobile';
import { fixtureHost, mockCompanion } from './fixtures/companion';

const chat = {
  id: 'chat-1',
  name: 'Prepare the next release',
  projectId: 'project-1',
};
function conversation(overrides: Partial<MobileChatDetail> = {}): MobileChatDetail {
  return {
    chat,
    subChatId: 'sub-1',
    subChats: [{ id: 'sub-1', name: 'Release', activity: 'idle' as const }],
    messages: [{ id: 'm1', role: 'assistant', text: 'Ready when you are.' }],
    hasMore: false,
    activity: 'idle' as const,
    kind: 'chat' as const,
    error: null,
    questions: [],
    permissions: [],
    ...overrides,
  };
}
async function openConversation(page: Page) {
  await page.getByRole('tab', { name: 'Chats', exact: true }).click();
  await page.getByRole('button').filter({ hasText: chat.name }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,authorization',
};

test('navigation preserves unsent text and the identity of an uncertain send', async ({ page }) => {
  await mockCompanion(page, { chat: conversation() });
  const sends: Array<{ requestId: string }> = [];
  await page.route(`${fixtureHost}/api`, async (route) => {
    if (
      route.request().method() !== 'POST' ||
      route.request().postDataJSON().type !== 'sendMessage'
    )
      return route.fallback();
    sends.push(route.request().postDataJSON());
    if (sends.length === 1) return route.abort('connectionreset');
    return route.fulfill({ headers, json: { data: { ok: true } } });
  });
  await openConversation(page);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Please verify staging first.');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.getByRole('button').filter({ hasText: chat.name }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Please verify staging first.',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(/it may have reached your computer/)).toBeVisible();
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.getByRole('button').filter({ hasText: chat.name }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Please verify staging first.',
  );
  expect(sends).toHaveLength(1);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  expect(sends).toHaveLength(2);
  expect(sends[0].requestId).toBe(sends[1].requestId);
});

test('conversation drafts belong to the selected subchat', async ({ page }) => {
  const primary = conversation({
    subChats: [
      { id: 'sub-1', name: 'Release', activity: 'idle' as const },
      { id: 'sub-2', name: 'Follow-up', activity: 'idle' as const },
    ],
  });
  const state = await mockCompanion(page, { chat: primary });
  await openConversation(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Release draft');
  state.data.chat = { ...primary, subChatId: 'sub-2' };
  await page.getByRole('tab', { name: 'Follow-up', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Follow-up draft');
  state.data.chat = primary;
  await page.getByRole('tab', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Release draft',
  );
});

test('queue opens the chosen decision and retains an unfinished answer', async ({ page }) => {
  const questions: MobileQuestion[] = ['First decision', 'Second decision'].map((title, index) => ({
    id: `q${index}`,
    chatId: chat.id,
    subChatId: 'sub-1',
    source: 'parked',
    title,
    questions: [],
  }));
  const detail = conversation({
    questions,
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      role: 'assistant',
      text: `Progress ${index}: the release checks are underway.`,
    })),
  });
  const state = await mockCompanion(page, {
    chat: detail,
    overview: {
      machineName: 'Studio Mac',
      executionReady: true,
      queue: [],
      questions,
      permissions: [],
    },
  });
  await page
    .getByRole('button', {
      name: 'Answer in chat: Second decision',
      exact: true,
    })
    .click();
  const target = page.getByTestId('decision-question-q1');
  await expect(target).toBeInViewport();
  await target
    .getByRole('textbox', { name: 'Reply to your agent', exact: true })
    .fill('Run staging smoke tests.');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Answer in chat: Second decision',
      exact: true,
    })
    .click();
  await expect(
    target.getByRole('textbox', { name: 'Reply to your agent', exact: true }),
  ).toHaveValue('Run staging smoke tests.');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  state.data.chat = { ...detail, questions: [] };
  await page
    .getByRole('button', {
      name: 'Answer in chat: Second decision',
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      'This request has already been resolved on your computer. The conversation is up to date.',
    ),
  ).toBeVisible();
});

test('long chats follow latest without moving a reader of earlier messages', async ({ page }) => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    text: `Update ${index}: checking the release and preparing the next step.`,
  }));
  const state = await mockCompanion(page, { chat: conversation({ messages }) });
  await openConversation(page);
  await expect(page.getByTestId('message-m29')).toBeInViewport();
  await page.getByTestId('chat-transcript').dispatchEvent('pointerdown');
  await page.getByTestId('chat-transcript').evaluate((element) => {
    element.scrollTop = 600;
  });
  await expect(page.getByRole('button', { name: 'Latest', exact: true })).toBeVisible();
  state.data.chat = conversation({
    messages: [
      ...messages,
      {
        id: 'newest',
        role: 'assistant',
        text: 'New result while you were reading.',
      },
    ],
  });
  await expect(page.getByTestId('message-newest')).toBeAttached();
  await expect(page.getByTestId('message-newest')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await expect(page.getByTestId('message-newest')).toBeInViewport();
});

test('loading earlier messages preserves the message being read', async ({ page }) => {
  // Enough newer content below the anchor that restoring its position never hits the scroll end.
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    text: `Message ${index}: release notes.`,
  }));
  await mockCompanion(page, {
    chat: conversation({ messages, hasMore: true }),
  });
  await page.route(`${fixtureHost}/api`, async (route) => {
    if (route.request().method() !== 'POST' || !route.request().postDataJSON().beforeMessageId)
      return route.fallback();
    return route.fulfill({
      headers,
      json: {
        data: conversation({
          messages: Array.from({ length: 8 }, (_, index) => ({
            id: `old${index}`,
            role: 'assistant',
            text: `Earlier ${index}: the plan before release.`,
          })),
        }),
      },
    });
  });
  await openConversation(page);
  // Let the initial follow-to-latest settle before the reader scrolls up.
  await expect(page.getByTestId('message-m19')).toBeInViewport();
  await page.getByTestId('chat-transcript').dispatchEvent('pointerdown');
  await page.getByTestId('chat-transcript').evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = page.getByTestId('message-m0');
  await expect(first).toBeInViewport();
  const before = (await first.boundingBox())!.y;
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(page.getByTestId('message-old0')).toBeAttached();
  await expect.poll(async () => Math.abs((await first.boundingBox())!.y - before)).toBeLessThan(5);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`rich transcript is readable and blocks remote images in ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    const images: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example')) images.push(request.url());
    });
    const state = await mockCompanion(page, {
      chat: conversation({
        messages: [
          {
            id: 'rich',
            role: 'assistant',
            text: '',
            parts: [
              {
                type: 'text',
                text: '## Release summary\n\nThe **staging checks** passed. Review [deployment notes](https://example.com/release).\n\n- Health endpoint is responding\n- Sign-in completed successfully',
              },
              {
                type: 'tool',
                id: 'tool1',
                name: 'Read release notes',
                state: 'completed',
              },
              {
                type: 'tool',
                id: 'tool2',
                name: 'Run smoke tests',
                state: 'completed',
              },
              {
                type: 'text',
                text: '```sh\nbun run test:release\n```\n\nNext, review the staging deployment before promoting to production.',
              },
            ],
          },
        ],
      }),
    });
    await openConversation(page);
    await expect(
      page.getByRole('heading', { name: 'Release summary', exact: true }),
    ).toBeAttached();
    await expect(page.locator('pre')).toContainText('bun run test:release');
    await expect(page.getByRole('link', { name: 'deployment notes', exact: true })).toHaveAttribute(
      'href',
      'https://example.com/release',
    );
    await page.getByRole('button', { name: '2 activities', exact: true }).click();
    await expect(page.getByText('Run smoke tests · Complete', { exact: true })).toBeVisible();
    await page.screenshot({
      path: `.expo/preview-02/chat-rich-${colorScheme}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    state.data.chat = conversation({
      messages: [
        {
          id: 'probe',
          role: 'assistant',
          text: '![Tracking pixel](https://untrusted.example/pixel.png)\n\n[Unsafe action](javascript:alert%281%29)',
        },
      ],
    });
    await expect(page.getByTestId('message-probe')).toBeAttached();
    await expect(
      page.getByText('Image: Tracking pixel (not loaded)', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Unsafe action', exact: true })).toHaveCount(0);
    await expect(page.locator('img[src*="untrusted.example"]')).toHaveCount(0);
    expect(images).toEqual([]);
  });
}

test('long code, a table and unavailable activity states fit a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockCompanion(page, {
    chat: conversation({
      messages: [
        {
          id: 'narrow',
          role: 'assistant',
          text: '',
          parts: [
            {
              type: 'text',
              text: '## Checks\n\n| Environment | Deployment |\n| --- | --- |\n| Staging | Ready for verification |\n\n```sh\ncurl https://staging.example.com/a/very/long/path/that/should/scroll/inside/the/code/block\n```',
            },
            { type: 'tool', id: 'a', name: 'Release task', state: 'interrupted' },
            { type: 'tool', id: 'b', name: 'Earlier activity', state: 'unknown' },
          ],
        },
      ],
    }),
  });
  await openConversation(page);
  await expect(page.locator('table')).toBeAttached();
  await page.getByRole('button', { name: '2 activities', exact: true }).click();
  await expect(page.getByText('Release task · Stopped', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Earlier activity · Status unavailable', { exact: true }),
  ).toBeVisible();
  const transcript = page.getByTestId('chat-transcript');
  const overflow = await transcript.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(overflow).toBe(false);
  const codeScroll = await page.locator('pre').evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    const result = {
      width: element.clientWidth,
      content: element.scrollWidth,
      offset: element.scrollLeft,
    };
    element.scrollLeft = 0;
    return result;
  });
  expect(codeScroll.content).toBeGreaterThan(codeScroll.width);
  expect(codeScroll.offset).toBeGreaterThan(0);
  await page.screenshot({ path: '.expo/preview-02/chat-narrow-dark.png', fullPage: true });
});

test('switching conversations clears the Latest control from the previous one', async ({
  page,
}) => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index}`,
    role: 'assistant',
    text: `Update ${index}: checking the release and preparing the next step.`,
  }));
  const subChats = [
    { id: 'sub-1', name: 'Release', activity: 'idle' as const },
    { id: 'sub-2', name: 'Follow-up', activity: 'idle' as const },
  ];
  const state = await mockCompanion(page, { chat: conversation({ messages, subChats }) });
  await openConversation(page);
  await page.getByTestId('chat-transcript').dispatchEvent('pointerdown');
  await page.getByTestId('chat-transcript').evaluate((element) => {
    element.scrollTop = 600;
  });
  await expect(page.getByRole('button', { name: 'Latest', exact: true })).toBeVisible();
  state.data.chat = conversation({ messages, subChats, subChatId: 'sub-2' });
  await page.getByRole('tab', { name: 'Follow-up', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Follow-up', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Latest', exact: true })).toHaveCount(0);
});
