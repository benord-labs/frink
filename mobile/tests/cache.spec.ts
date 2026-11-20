import { expect, test, type Page } from '@playwright/test';
import { UNKNOWN_REQUEST, openApp } from './fixtures/app';
import { conversation, openChat, requestsOf } from './fixtures/chat';
import { NOW, overviewFixture } from './fixtures/data';
import { macFlows } from './fixtures/flows';
import { openDestination, openTab } from './fixtures/navigation';

const offlineBanner = (page: Page) => page.getByText('Can’t reach your Mac', { exact: true });

/** Six running Flows, one more than a collapsed section shows, the newest titled `newest`. */
function sixRunning(newest: string) {
  const overview = overviewFixture();
  const [template] = overview.queue.filter((item) => item.section === 'running');
  if (!template) throw new Error('The overview fixture has no running row');
  const running = Array.from({ length: 6 }, (_, index) => ({
    ...template,
    id: `busy-${index}`,
    title: index === 0 ? newest : `Nightly build ${index}`,
    activityAt: new Date(NOW - index * 60_000).toISOString(),
  }));
  return {
    ...overview,
    queue: [...overview.queue.filter((item) => item.section !== 'running'), ...running],
    counts: { ...overview.counts, running: running.length },
  };
}

test('Flows reopens with its last rows even when the Mac is unreachable', async ({ page }) => {
  const state = await openApp(page, { data: { flows: macFlows() } });
  await openDestination(page, 'Flows');
  await expect(page.getByTestId('flow-activity-flow-1')).toBeVisible();
  await openDestination(page, 'Settings');
  state.offline = true;
  await openDestination(page, 'Flows');
  await expect(page.getByTestId('flow-activity-flow-1')).toBeVisible();
});

test('Flows opens warm on first visit', async ({ page }) => {
  const state = await openApp(page, { data: { flows: macFlows() } });
  await expect(page.getByTestId('chat-row-chat-1')).toBeVisible();
  await expect.poll(() => requestsOf(state, 'flows').length).toBe(1);
  state.offline = true;
  await openTab(page, 'Flows');
  await expect(page.getByTestId('flow-activity-flow-1')).toBeVisible();
});

test('re-expanding a Queue section shows the live rows, not an earlier expansion', async ({
  page,
}) => {
  const state = await openApp(page, { data: { overview: sixRunning('Old build') } });
  await openDestination(page, 'Queue');
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.getByText('Nightly build 5')).toBeVisible();
  await page.getByRole('button', { name: 'Show less' }).click();
  state.data.overview = sixRunning('New build');
  await expect(page.getByText('New build')).toBeVisible();
  state.offline = true;
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(offlineBanner(page)).toBeVisible();
  await expect(page.getByText('Old build')).toHaveCount(0);
  await expect(page.getByText('New build')).toBeVisible();
});

test('a chat reads readiness from the shared overview poll', async ({ page }) => {
  const state = await openApp(page, { data: { chat: conversation() } });
  await openChat(page);
  await expect(page.getByTestId('message-m1')).toBeVisible();
  await page.waitForTimeout(500);
  const overviews = requestsOf(state, 'overview');
  expect(overviews.length).toBeGreaterThan(0);
  expect(overviews.filter((input) => 'limits' in input)).toEqual([]);
});

// Against a desktop too old to push live updates, so the chat keeps its quick polls.
test.describe('a polled chat', () => {
  async function openPausedChat(page: Page) {
    const state = await openApp(page, {
      data: { chat: conversation() },
      respond: (input) => (input.type === 'watchChat' ? UNKNOWN_REQUEST : undefined),
    });
    await openChat(page);
    await expect(page.getByTestId('message-m1')).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    // Lets any poll the jump started finish before counting.
    await page.waitForTimeout(500);
    return state;
  }

  test('starting work does not restart the poll', async ({ page }) => {
    const state = await openPausedChat(page);
    const before = requestsOf(state, 'chat').length;
    state.data.chat = conversation({}, 'running');
    await page.clock.runFor(4000);
    await expect(page.getByTestId('chat-subtitle')).toContainText('Running');
    await page.waitForTimeout(1000);
    expect(requestsOf(state, 'chat').length).toBe(before + 1);
    // The running chat's shorter interval applies to the tick already waiting.
    await page.clock.runFor(2000);
    await expect.poll(() => requestsOf(state, 'chat').length).toBe(before + 2);
  });

  test('an offline banner clears when the next poll answers the same chat', async ({ page }) => {
    const state = await openPausedChat(page);
    state.offline = true;
    await page.clock.runFor(4000);
    await expect(offlineBanner(page)).toBeVisible();
    state.offline = false;
    await page.clock.runFor(4000);
    await expect(offlineBanner(page)).toHaveCount(0);
    await expect(page.getByTestId('message-m1')).toBeVisible();
  });
});
