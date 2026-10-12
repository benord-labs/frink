import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { MobileQueueItem } from '@frink/shared/types/remote/mobile';
import { openApp } from './fixtures/app';
import { NOW, overviewFixture } from './fixtures/data';

// The first web bundle can take a while while other previews rebuild on this machine.
const expect = baseExpect.configure({ timeout: 15_000 });

const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/queue-${state}-${scheme}.png` });
const row = (page: Page, key: string) => page.getByTestId(`queue-row-${key}`);

async function openQueue(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, options);
  await page.getByTestId('queue-open').click();
  return state;
}

/** Eight running Flow steps: more than a collapsed section shows. */
function busyOverview() {
  const overview = overviewFixture();
  const running: MobileQueueItem[] = Array.from({ length: 8 }, (_, index) => ({
    id: `busy-${index + 1}`,
    title: `Nightly build ${index + 1}`,
    summary: `Step ${index + 1} of 9 · Compile`,
    status: 'running',
    section: 'running',
    chatId: `busy-chat-${index + 1}`,
    subChatId: `busy-sub-${index + 1}`,
    flowRunId: `busy-run-${index + 1}`,
    projectName: 'frink',
    activityAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
    actions: [],
  }));
  return {
    ...overview,
    queue: [...overview.queue.filter((item) => item.section !== 'running'), ...running],
    counts: { ...overview.counts, running: running.length },
  };
}

test('shows what needs you, what is running, what is ready and what is next', async ({ page }) => {
  await openQueue(page);
  await expect(row(page, 'question:question-1')).toContainText(
    'Should I switch the CI cache to the lockfile hash?',
  );
  // Decisions lead, then tasks newest first; finished work waits in its own calm section.
  const needsYou = ['question:question-1', 'permission:perm-1', 'task-plan', 'task-failed'];
  const rows = page.locator('[data-testid^="queue-row-"]');
  await expect(rows).toHaveCount(8);
  expect(
    (await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.testid))).slice(0, 4),
  ).toEqual(needsYou.map((key) => `queue-row-${key}`));
  await expect(row(page, 'permission:perm-1')).toContainText('Chat · Wants your approval');
  await expect(row(page, 'task-failed')).toContainText('Flow · frink · Step 3 of 5 failed');
  await expect(row(page, 'task-failed')).toContainText('Failed');
  await expect(row(page, 'task-run-flow')).toContainText('Flow · design-system · Step 2 of 4');
  await expect(row(page, 'task-run-chat')).toContainText('Chat · frink');
  await expect(row(page, 'task-done')).toContainText('Ready');
  await expect(row(page, 'task-inbox')).toContainText('Queued');
  await expect(row(page, 'task-plan')).not.toContainText('Plan is ready');
  for (const title of ['Needs you', 'Running', 'Ready for review', 'Up next'])
    await expect(page.getByRole('heading', { name: new RegExp(`^${title}`) })).toBeVisible();
  // Question + permission + plan ready + failed, and the finished task the phone can complete.
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByTestId('queue-open')).toContainText('5');
  await page.getByTestId('queue-open').click();
  await expect(page.getByText("Benji's MacBook Pro")).toBeVisible();
  await shot(page, 'sections');
  await page.mouse.wheel(0, 600);
  await expect(row(page, 'task-inbox')).toBeInViewport();
  await shot(page, 'sections-bottom');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.wheel(0, -600);
  await shot(page, 'sections', 'light');
});

test('opens a decision at its question, a Flow at its run and a task at its chat', async ({
  page,
}) => {
  const state = await openQueue(page);
  const opened = (type: string, id: string) =>
    expect.poll(() => state.requests.some((r) => r.type === type && r.id === id)).toBe(true);
  // Each tap starts from a fresh Queue: the web preview keeps no navigation history.
  for (const [key, type, id] of [
    ['question:question-1', 'chat', 'chat-5'],
    ['task-run-flow', 'run', 'run-1'],
    ['task-plan', 'chat', 'chat-4'],
  ]) {
    await page.reload();
    await page.getByTestId('queue-open').click();
    await row(page, key).click();
    await opened(type, id);
  }
});

test('Show all grows the section with a larger server page', async ({ page }) => {
  const state = await openQueue(page, { data: { overview: busyOverview() } });
  await expect(page.locator('[data-testid^="queue-row-busy-"]')).toHaveCount(5);
  await shot(page, 'collapsed');
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect
    .poll(() =>
      state.requests.some(
        (r) => r.type === 'overview' && JSON.stringify(r.limits) === JSON.stringify({ running: 8 }),
      ),
    )
    .toBe(true);
  await expect(page.locator('[data-testid^="queue-row-busy-"]')).toHaveCount(8);
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(page.locator('[data-testid^="queue-row-busy-"]')).toHaveCount(5);
});

test('says you are all caught up when nothing is waiting', async ({ page }) => {
  const overview = {
    ...overviewFixture(),
    queue: [],
    questions: [],
    permissions: [],
    counts: { attention: 0, running: 0, inbox: 0 },
  };
  await openQueue(page, { data: { overview } });
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await page.getByRole('link', { name: /back/i }).click();
  await expect(page.getByTestId('queue-open')).not.toContainText(/\d/);
  await page.getByTestId('queue-open').click();
  await shot(page, 'empty');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'empty', 'light');
});

test('keeps the last queue on screen when the Mac stops answering', async ({ page }) => {
  const state = await openQueue(page);
  await expect(row(page, 'task-plan')).toBeVisible();
  state.offline = true;
  await page.clock.runFor(4000);
  await expect(page.getByText('Can’t reach your Mac')).toBeVisible();
  await expect(row(page, 'task-plan')).toBeVisible();
  await shot(page, 'offline');
});

test('explains that Frink must be open on the Mac to run chats', async ({ page }) => {
  await openQueue(page, { data: { overview: { ...overviewFixture(), executionReady: false } } });
  await expect(page.getByText('Open Frink on your Mac to run chats')).toBeVisible();
  await expect(row(page, 'task-plan')).toBeVisible();
  await shot(page, 'not-ready');
});

/** A chat task parked on a usage limit: it continues its session or is marked complete. */
function parkedOverview() {
  const overview = overviewFixture();
  const parked: MobileQueueItem = {
    id: 'task-parked',
    title: 'Migrate the billing webhooks to v2',
    summary: 'Paused at the usage limit',
    status: 'needs_attention',
    section: 'attention',
    chatId: 'chat-7',
    subChatId: 'sub-7',
    flowRunId: null,
    projectName: 'billing-api',
    activityAt: new Date(NOW - 20 * 60_000).toISOString(),
    actions: ['continueTask', 'completeTask'],
    recoveryKind: 'continue',
  };
  return { ...overview, queue: [parked, ...overview.queue] };
}

/** Adds a chat task that failed before it started: it has no session, so it can only run again. */
function recoveryOverview() {
  const overview = parkedOverview();
  const neverStarted: MobileQueueItem = {
    ...overview.queue[0],
    id: 'task-never-started',
    title: 'Rotate the staging API keys',
    summary: 'Could not start',
    status: 'failed',
    chatId: 'chat-8',
    subChatId: 'sub-8',
    actions: ['continueTask'],
    recoveryKind: 'retry',
  };
  return { ...overview, queue: [neverStarted, ...overview.queue] };
}

/** Adds a Flow run that stopped on a started command: its Retry may repeat what it did. */
function sideEffectsOverview() {
  const overview = parkedOverview();
  const command: MobileQueueItem = {
    ...overview.queue[0],
    id: 'task-deploy-flow',
    title: 'Deploy the docs site',
    summary: 'Stopped on Publish',
    status: 'failed',
    chatId: 'chat-9',
    subChatId: 'sub-9',
    flowRunId: 'run-9',
    actions: ['continueTask'],
    recoveryKind: 'retry',
    confirmSideEffects: true,
    recoveryNodeRunId: 'node-publish',
  };
  return { ...overview, queue: [command, ...overview.queue] };
}

/** Swipes a row open by scrolling its own horizontal scroller to the end. */
async function swipeOpen(page: Page, key: string, label: string) {
  const action = page.getByRole('button', { name: label, exact: true });
  await expect(action).toBeAttached();
  // Centred, so the row sits clear of the screen edge.
  await row(page, key).evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await expect(action).not.toBeInViewport();
  // react-native-web replaces scrollTo, so set scrollLeft directly.
  await action.evaluate((button) => {
    let node = button.parentElement;
    while (node && node.scrollWidth <= node.clientWidth) node = node.parentElement;
    if (node) node.scrollLeft = node.scrollWidth;
  });
  await expect(action).toBeInViewport();
  return action;
}

const sent = (state: Awaited<ReturnType<typeof openApp>>) =>
  state.requests.filter((r) => ['completeTask', 'continueTask', 'startTask'].includes(r.type));

test('swiping a task offers the desktop’s actions and sends the chosen one', async ({ page }) => {
  const state = await openQueue(page, { data: { overview: recoveryOverview() } });
  const title = 'Migrate the billing webhooks to v2';
  const carryOn = await swipeOpen(page, 'task-parked', `Continue task: ${title}`);
  await expect(page.getByRole('button', { name: `Mark complete: ${title}` })).toBeInViewport();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'test-results/sc4143-swipe-two-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: 'test-results/sc4143-swipe-two-light.png' });
  await carryOn.click();
  await expect
    .poll(() => sent(state))
    .toEqual([{ type: 'continueTask', id: 'task-parked', kind: 'continue' }]);
  // The same swipe on a task with no session to resume runs it again, as desktop's does.
  await page.waitForTimeout(500);
  const retry = await swipeOpen(
    page,
    'task-never-started',
    'Retry task: Rotate the staging API keys',
  );
  await retry.click();
  await expect
    .poll(() => sent(state).slice(1))
    .toEqual([{ type: 'continueTask', id: 'task-never-started', kind: 'retry' }]);

  await page.emulateMedia({ colorScheme: 'dark' });
  const complete = await swipeOpen(
    page,
    'task-done',
    'Mark complete: Add dark mode to the pricing page',
  );
  await page.screenshot({ path: 'test-results/sc4143-swipe-complete-dark.png' });
  await complete.click();
  // Let the row finish closing: the next row's scroll would cut its animation short.
  await page.waitForTimeout(500);
  const start = await swipeOpen(
    page,
    'task-inbox',
    'Start task: Summarise yesterday’s support emails',
  );
  await page.screenshot({ path: 'test-results/sc4143-swipe-start-dark.png' });
  await start.click();
  await expect
    .poll(() => sent(state).slice(2))
    .toEqual([
      { type: 'completeTask', id: 'task-done' },
      { type: 'startTask', id: 'task-inbox' },
    ]);
});

test('a Flow Retry that may repeat side effects asks first, then pins the step', async ({
  page,
}) => {
  const state = await openQueue(page, { data: { overview: sideEffectsOverview() } });
  // The phone tells the computer it can ask, or a step like this is never offered to it.
  await expect
    .poll(() => state.requests)
    .toContainEqual(expect.objectContaining({ type: 'overview', confirmsSideEffects: true }));
  const label = 'Retry task: Deploy the docs site';
  const prompts: string[] = [];
  page.once('dialog', (dialog) => {
    prompts.push(dialog.message());
    void dialog.dismiss();
  });
  await (await swipeOpen(page, 'task-deploy-flow', label)).click();
  await expect
    .poll(() => prompts)
    .toEqual([
      'Retry this step?\n\nThis step was interrupted partway through. Running it again may repeat actions it already took.',
    ]);
  await page.waitForTimeout(500);
  expect(sent(state)).toEqual([]);

  page.once('dialog', (dialog) => void dialog.accept());
  await (await swipeOpen(page, 'task-deploy-flow', label)).click();
  await expect
    .poll(() => sent(state))
    .toEqual([
      {
        type: 'continueTask',
        id: 'task-deploy-flow',
        kind: 'retry',
        recoveryNodeRunId: 'node-publish',
      },
    ]);
});

test('decisions, a failed Flow and running work have no swipe actions', async ({ page }) => {
  await openQueue(page, { data: { overview: parkedOverview() } });
  await expect(page.getByRole('button', { name: /^Continue task: / })).toBeAttached();
  for (const key of ['question:question-1', 'task-failed', 'task-run-flow', 'task-plan'])
    await expect(row(page, key)).toBeVisible();
  // Only the parked, finished and inbox tasks carry actions.
  await expect(
    page.getByRole('button', { name: /^(Start task|Continue task|Retry task|Mark complete): / }),
  ).toHaveCount(4);
});

test('an action the computer refuses explains why', async ({ page }) => {
  const reason = 'This item changed. Refresh and try again.';
  await openQueue(page, {
    respond: (input) => (input.type === 'completeTask' ? new Error(reason) : undefined),
  });
  const complete = await swipeOpen(
    page,
    'task-done',
    'Mark complete: Add dark mode to the pricing page',
  );
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await complete.click();
  await expect.poll(() => messages).toEqual([`Couldn’t mark complete\n\n${reason}`]);
});
