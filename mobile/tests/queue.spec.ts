import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { MobileQueueItem } from '../../src/shared/types/remote/mobile';
import { openApp } from './fixtures/app';
import { NOW, overviewFixture } from './fixtures/data';

// The first web bundle can take a while while other previews rebuild on this machine.
const expect = baseExpect.configure({ timeout: 15_000 });

const shot = (page: Page, state: string, scheme = 'dark') =>
  page.screenshot({ path: `test-results/queue-${state}-${scheme}.png` });
const row = (page: Page, key: string) => page.getByTestId(`queue-row-${key}`);

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
  }));
  return {
    ...overview,
    queue: [...overview.queue.filter((item) => item.section !== 'running'), ...running],
    counts: { ...overview.counts, running: running.length },
  };
}

test('shows what needs you, what is running, what is ready and what is next', async ({ page }) => {
  await openApp(page);
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
  // Question + permission + plan ready + failed; "Ready for review" is not counted.
  await expect(page.getByTestId('tab-queue')).toContainText('4');
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
  const state = await openApp(page);
  const opened = (type: string, id: string) =>
    expect.poll(() => state.requests.some((r) => r.type === type && r.id === id)).toBe(true);
  // Each tap starts from a fresh Queue: the web preview keeps no navigation history.
  for (const [key, type, id] of [
    ['question:question-1', 'chat', 'chat-5'],
    ['task-run-flow', 'run', 'run-1'],
    ['task-plan', 'chat', 'chat-4'],
  ]) {
    await page.reload();
    await row(page, key).click();
    await opened(type, id);
  }
});

test('Show all grows the section with a larger server page', async ({ page }) => {
  const state = await openApp(page, { data: { overview: busyOverview() } });
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
  await openApp(page, { data: { overview } });
  await expect(page.getByText('You’re all caught up')).toBeVisible();
  await expect(page.getByTestId('tab-queue')).not.toContainText(/\d/);
  await shot(page, 'empty');
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, 'empty', 'light');
});

test('keeps the last queue on screen when the Mac stops answering', async ({ page }) => {
  const state = await openApp(page);
  await expect(row(page, 'task-plan')).toBeVisible();
  state.offline = true;
  await page.clock.runFor(4000);
  await expect(page.getByText('Can’t reach your Mac')).toBeVisible();
  await expect(row(page, 'task-plan')).toBeVisible();
  await shot(page, 'offline');
});

test('explains that Frink must be open on the Mac to run chats', async ({ page }) => {
  await openApp(page, { data: { overview: { ...overviewFixture(), executionReady: false } } });
  await expect(page.getByText('Open Frink on your Mac to run chats')).toBeVisible();
  await expect(row(page, 'task-plan')).toBeVisible();
  await shot(page, 'not-ready');
});
