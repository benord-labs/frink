import { expect, test, type Page } from '@playwright/test';

const host = 'https://mobile-fixture.example.test';
const prompt = {
  id: 'question-1',
  source: 'live',
  chatId: 'chat-1',
  subChatId: 'sub-1',
  title: 'Release checks',
  questions: [
    {
      header: 'Publish',
      question: 'Which environment should I use?',
      options: [
        { label: 'Staging', description: 'Validate before production.' },
        { label: 'Production', description: 'Publish the release.' },
      ],
      multiSelect: false,
    },
  ],
};
const flow = {
  id: 'flow-1',
  name: 'Morning issue triage',
  description: 'Review incoming issues and prepare the next steps.',
  enabled: true,
  trigger: 'schedule_trigger',
  latestRunId: 'run-1',
  status: 'paused',
};
const chat = { id: 'chat-1', name: 'Prepare the next release', projectId: 'project-1' };

async function connect(
  page: Page,
  options: {
    lostSend?: boolean;
    prose?: boolean;
    failed?: boolean;
    active?: boolean;
    crowdedQueue?: boolean;
  } = {},
) {
  let answered = false;
  let sent = 0;
  let active = options.active ?? false;
  const mutations: string[] = [];
  const resumes: unknown[] = [];
  const question = options.prose
    ? {
        ...prompt,
        source: 'parked',
        questions: [],
        title: 'Please clarify what should happen after deployment.',
      }
    : prompt;
  const questions = options.crowdedQueue
    ? [
        question,
        {
          ...prompt,
          id: 'question-2',
          title: 'Smoke tests',
          questions: [
            {
              ...prompt.questions[0],
              question: 'Which smoke tests should run before promoting this release?',
            },
          ],
        },
      ]
    : [question];
  const permissions = options.crowdedQueue
    ? [
        {
          requestId: 'permission-1',
          chatId: chat.id,
          subChatId: 'sub-1',
          title: 'Allow the release command?',
          description: 'The agent wants to run the staging release checks on your computer.',
          supported: true,
        },
        {
          requestId: 'permission-2',
          chatId: chat.id,
          subChatId: 'sub-1',
          title: 'Allow access to deployment logs?',
          description: 'Read the latest deployment logs to verify the release.',
          supported: true,
        },
      ]
    : [];
  await page.route(`${host}/**`, async (route) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,authorization',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/pair'))
      return route.fulfill({
        json: {
          token: 'b'.repeat(43),
          deviceId: 'device-1',
          machineName: 'Benji’s Mac',
          apiVersion: 1,
        },
        headers,
      });
    const input = route.request().postDataJSON();
    if (input.type === 'resumeNode') resumes.push(input);
    if (
      [
        'answerQuestion',
        'sendMessage',
        'startFlow',
        'resumeNode',
        'setFlowEnabled',
        'stopChat',
      ].includes(input.type)
    )
      mutations.push(input.type);
    if (input.type === 'answerQuestion') answered = true;
    if (input.type === 'stopChat') active = false;
    if (input.type === 'sendMessage') {
      sent++;
      if (options.lostSend) return route.abort('connectionreset');
    }
    const responses: Record<string, unknown> = {
      overview: {
        machineName: 'Benji’s Mac',
        executionReady: true,
        questions: answered ? [] : questions,
        permissions,
        queue: [
          {
            id: 'task-1',
            title: 'Release checks',
            summary: 'Waiting for your environment choice.',
            status: 'needs_attention',
            section: 'attention',
            chatId: 'chat-1',
            subChatId: 'sub-1',
            flowRunId: 'run-1',
          },
          {
            id: 'task-2',
            title: 'Review incoming issues',
            summary: 'Morning issue triage',
            status: 'running',
            section: 'running',
            chatId: 'chat-1',
            subChatId: 'sub-1',
            flowRunId: 'run-1',
          },
          ...(options.crowdedQueue
            ? [
                {
                  id: 'task-3',
                  title: 'Approve the production rollout plan',
                  summary: 'Independent Flow review in the same chat.',
                  status: 'needs_attention',
                  section: 'attention',
                  chatId: chat.id,
                  subChatId: 'sub-1',
                  flowRunId: 'run-1',
                },
                {
                  id: 'task-4',
                  title: 'Waiting for repository indexing',
                  summary: 'Your computer is preparing the workspace.',
                  status: 'queued',
                  section: 'inbox',
                  chatId: null,
                  subChatId: null,
                  flowRunId: null,
                },
              ]
            : []),
        ],
      },
      flows: [flow],
      flow: { flow, runs: [{ id: 'run-1', status: 'paused', startedAt: '2026-09-27T08:30:00Z' }] },
      run: {
        id: 'run-1',
        flowId: flow.id,
        flowName: flow.name,
        status: 'paused',
        startedAt: null,
        nodes: [
          {
            id: 'node-1',
            label: 'Review the release plan',
            status: 'awaiting_input',
            detail: 'Deploy to staging, run smoke tests, then ask before promoting to production.',
            actions: ['approve'],
            actionToken: 'c'.repeat(64),
            chatId: chat.id,
            subChatId: 'sub-1',
          },
        ],
      },
      chats: [chat],
      chat: {
        chat,
        subChatId: 'sub-1',
        subChats: [{ id: 'sub-1', name: 'Release' }],
        messages: [
          { id: 'm-1', role: 'user', text: 'Check the release and prepare a deployment plan.' },
          {
            id: 'm-2',
            role: 'assistant',
            text: 'The checks are complete. I need your choice before continuing.',
          },
        ],
        hasMore: false,
        active,
        error: options.failed
          ? 'The response failed. Check Frink on your computer for details.'
          : null,
        questions: answered ? [] : questions,
        permissions,
      },
      projects: [{ id: 'project-1', name: 'Frink' }],
      createChat: { chatId: 'chat-1', subChatId: 'sub-1' },
      startFlow: { id: 'run-1' },
    };
    await route.fulfill({ json: { data: responses[input.type] ?? { ok: true } }, headers });
  });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(JSON.stringify({ version: 1, url: host, code: 'a'.repeat(43) }));
  await page.getByRole('button', { name: 'Connect to Frink', exact: true }).click();
  await expect(page.getByText('Work queue', { exact: true })).toBeVisible();
  return { mutations, resumes, sends: () => sent };
}

test('phone queue, structured answers, Flow review and chat work without horizontal overflow', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await connect(page);
  await page.screenshot({ path: 'test-results/queue-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Answer in chat', exact: true }).click();
  await expect(page.getByText('Your answer is needed', { exact: true })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connection settings', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('radio').filter({ hasText: 'Staging' }).click();
  await expect(page.getByRole('radio').filter({ hasText: 'Staging' })).toBeChecked();
  await page.screenshot({ path: 'test-results/chat-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Your answer is needed', { exact: true })).toHaveCount(0);
  expect(state.mutations).toContain('answerQuestion');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-composer-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByText('Work queue', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Queue', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Flows', exact: true }).click();
  await expect(page.getByRole('button').filter({ hasText: 'Morning issue triage' })).toBeVisible();
  await page.screenshot({ path: 'test-results/flow-list-dark.png', fullPage: true });
  await page.getByRole('button').filter({ hasText: 'Morning issue triage' }).click();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run Flow', exact: true }).click();
  await expect(
    page.getByText('Deploy to staging, run smoke tests, then ask before promoting to production.'),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/run-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Approve this step', exact: true }).click();
  expect(state.mutations).toContain('resumeNode');
  expect(state.resumes).toEqual([
    {
      type: 'resumeNode',
      runId: 'run-1',
      nodeRunId: 'node-1',
      action: 'approve',
      actionToken: 'c'.repeat(64),
    },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run Flow', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Automation enabled', exact: true })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Flows', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button').filter({ hasText: 'Morning issue triage' })).toBeVisible();
  await page.getByRole('button', { name: 'Connection settings', exact: true }).click();
  await expect(page.getByText('Your computer', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Connected. Frink is ready for your work.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/connection-dark.png', fullPage: true });
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Flows', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(errors).toEqual([]);
});

test('prose-only parked questions have a working reply form on a small light phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'light' });
  const state = await connect(page, { prose: true });
  await page.screenshot({ path: 'test-results/queue-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Answer in chat', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Reply to your agent', exact: true })
    .fill('Please run the staging smoke tests next.');
  await page.screenshot({ path: 'test-results/answer-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Your answer is needed', { exact: true })).toHaveCount(0);
  expect(state.mutations).toEqual(['answerQuestion']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('a lost send response preserves the draft without automatic replay', async ({ page }) => {
  const state = await connect(page, { lostSend: true });
  await page.getByRole('button', { name: 'Answer in chat', exact: true }).click();
  await page.getByRole('radio').filter({ hasText: 'Staging' }).click();
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.getByText('Your answer is needed', { exact: true })).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Please show me the next task.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(/it may have reached your computer/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Please show me the next task.',
  );
  expect(state.sends()).toBe(1);
});

test('revoking the phone clears the session and returns to pairing', async ({ page }) => {
  await connect(page);
  await page.route(`${host}/api`, (route) =>
    route.fulfill({
      status: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,authorization',
      },
      json: { error: 'Unauthorized' },
    }),
  );
  await expect(
    page.getByText('This connection was revoked. Pair your computer again.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Pairing code', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flows', exact: true })).toHaveCount(0);
});

test('a failed agent response is visible in the conversation', async ({ page }) => {
  await connect(page, { failed: true });
  await page.getByRole('button', { name: 'Answer in chat', exact: true }).click();
  await expect(
    page.getByText('The response failed. Check Frink on your computer for details.'),
  ).toBeVisible();
});

test('stopping a response requires confirmation of its active Flow scope', async ({ page }) => {
  const state = await connect(page, { active: true });
  await page.getByRole('button', { name: 'Answer in chat', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response…', exact: true }).click();
  await expect(page.getByText('Stopping also ends any active Flow in this chat.')).toBeVisible();
  expect(state.mutations).toEqual([]);

  await page.getByRole('button', { name: 'Keep running', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm stop', exact: true })).toHaveCount(0);
  expect(state.mutations).toEqual([]);

  await page.getByRole('button', { name: 'Stop response…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm stop', exact: true }).click();
  await expect(page.getByText('Answer above to continue', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm stop', exact: true })).toHaveCount(0);
  expect(state.mutations).toEqual(['stopChat']);
});

test('queue keeps independent decisions in one chat reachable on a small light phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: 'light' });
  await connect(page, { crowdedQueue: true });

  await expect(page.getByText('Which environment should I use?', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Release checks', { exact: true })).toHaveCount(1);
  const secondaryQuestion = 'Which smoke tests should run before promoting this release?';
  const independentDecisions = [
    secondaryQuestion,
    'Allow the release command?',
    'Allow access to deployment logs?',
    'Approve the production rollout plan',
  ];
  for (const title of independentDecisions)
    await expect(page.getByRole('button').filter({ hasText: title })).toHaveCount(1);
  await expect(
    page.getByText('Read the latest deployment logs to verify the release.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for repository indexing', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button').filter({ hasText: 'Waiting for repository indexing' }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  for (const title of independentDecisions) {
    const chatRequest = page.waitForRequest((request) => {
      if (!request.url().endsWith('/api') || request.method() !== 'POST') return false;
      const input = request.postDataJSON();
      return input.type === 'chat' && input.id === chat.id && input.subChatId === 'sub-1';
    });
    await page.getByRole('button').filter({ hasText: title }).click();
    await chatRequest;
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByText('Answer above to continue', { exact: true })).toBeVisible();
    await expect(page.getByText(secondaryQuestion, { exact: true })).toBeVisible();
    await expect(page.getByText('Allow access to deployment logs?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page.getByText('Work queue', { exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Queue', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
});
