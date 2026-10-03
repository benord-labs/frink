import { expect, test, type Page } from '@playwright/test';
import { openApp, type AppState } from './fixtures/app';
import { overviewFixture } from './fixtures/data';
import { flowFor, macFlows, waitingRun } from './fixtures/flows';

// SHOT_DIR keeps screenshots out of reach of parallel runs that clear test-results/.
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `${process.env.SHOT_DIR ?? 'test-results'}/flows-${name}.png`,
    fullPage: true,
  });

/** Detail screens scroll inside the app, so a tall viewport shows the whole screen in one image. */
async function tallShot(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 1700 });
  await shot(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
}

/** Answers `flow` per id and window, as the computer does. */
const perFlow: AppState['respond'] = (input) =>
  input.type === 'flow' ? flowFor(String(input.id), Number(input.runLimit ?? 5)) : undefined;

async function openFlows(page: Page, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openApp(page, {
    respond: perFlow,
    ...options,
    data: { flows: macFlows(), ...options.data },
  });
  await page.getByTestId('tab-flows').click();
  return state;
}

async function openFlow(page: Page, id: string, options: Parameters<typeof openApp>[1] = {}) {
  const state = await openFlows(page, options);
  await page.getByTestId(`flow-row-${id}`).click();
  return state;
}

const lastOf = (state: AppState, type: string) =>
  state.requests.filter((request) => request.type === type).at(-1);

test.describe('Flows tab', () => {
  test('groups Flows like the desktop list, with one state per row', async ({ page }) => {
    await openFlows(page);
    const sections = page.getByRole('heading');
    await expect(sections.filter({ hasText: 'Needs you' })).toContainText('2');
    await expect(sections.filter({ hasText: 'Enabled' })).toContainText('2');
    await expect(sections.filter({ hasText: 'Disabled' })).toContainText('1');
    const order = await page
      .locator('[data-testid^="flow-row-"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
    // Needs you (waiting, failed), Enabled (running, done), Disabled.
    expect(order).toEqual([
      'flow-row-flow-2',
      'flow-row-flow-3',
      'flow-row-flow-1',
      'flow-row-flow-4',
      'flow-row-flow-5',
    ]);
    await expect(page.getByTestId('flow-row-flow-1')).toContainText('Running');
    await expect(page.getByTestId('flow-row-flow-2')).toContainText('Failed');
    await expect(page.getByTestId('flow-row-flow-3')).toContainText('Waiting for you');
    await expect(page.getByTestId('flow-row-flow-4')).toContainText('7h');
    await expect(page.getByTestId('flow-row-flow-5')).toContainText('Off');
    await expect(page.getByTestId('flow-row-flow-4')).toContainText('Summarises support email');
    await shot(page, 'list-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'list-light');
  });

  test('searches names and descriptions, and recovers from no matches', async ({ page }) => {
    await openFlows(page);
    const search = page.getByRole('textbox', { name: 'Search flows' });
    await search.fill('github');
    await expect(page.getByTestId('flow-row-flow-2')).toBeVisible();
    await expect(page.locator('[data-testid^="flow-row-"]')).toHaveCount(1);
    await search.fill('unmatched');
    await expect(page.getByText('No Flows match “unmatched”')).toBeVisible();
    await shot(page, 'no-match-dark');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('[data-testid^="flow-row-"]')).toHaveCount(5);
  });

  test('explains where Flows come from when there are none', async ({ page }) => {
    await openFlows(page, { data: { flows: [] } });
    await expect(page.getByText('No Flows yet')).toBeVisible();
    await expect(page.getByText(/automations you build in Frink on your Mac/)).toBeVisible();
    await shot(page, 'empty-dark');
  });

  test('keeps the list and says so when the Mac goes offline', async ({ page }) => {
    const state = await openFlows(page);
    await expect(page.getByTestId('flow-row-flow-1')).toBeVisible();
    state.offline = true;
    await page.clock.runFor(6000);
    await expect(page.getByTestId('flows-screen').getByText('Can’t reach your Mac')).toBeVisible();
    await expect(page.getByTestId('flow-row-flow-1')).toBeVisible();
    await shot(page, 'offline-dark');
  });
});

test.describe('Flow detail', () => {
  test('Run now starts a run with a fresh request id and opens it', async ({ page }) => {
    const state = await openFlow(page, 'flow-4');
    await expect(
      page.getByText('Summarises support email every morning').filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByText('Runs when its webhook is called')).toBeVisible();
    state.data.startFlow = { id: 'run-1' };
    const flowFetches = () => state.requests.filter((request) => request.type === 'flow').length;
    const before = flowFetches();
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(() => lastOf(state, 'startFlow')).toBeDefined();
    const start = lastOf(state, 'startFlow');
    expect(start).toMatchObject({ type: 'startFlow', id: 'flow-4' });
    expect(String(start?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId('run-step-nr2')).toBeVisible();
    // Hidden under the run, the Flow waits; going back fetches it at once, showing the new run.
    expect(flowFetches()).toBe(before);
    await page.getByRole('link', { name: 'Go back' }).click();
    await expect.poll(flowFetches).toBeGreaterThan(before);
  });

  test('a running Flow offers its current run instead of Run now', async ({ page }) => {
    const state = await openFlow(page, 'flow-1');
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    await expect(page.getByText('This Flow is running now.')).toHaveCount(0);
    await shot(page, 'detail-running-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'detail-running-light');
    await page.getByRole('button', { name: 'View current run' }).click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-1' });
  });

  test('a Flow waiting on you says so and opens the run to decide', async ({ page }) => {
    const state = await openFlows(page, { data: { run: waitingRun() } });
    const waiting = page.getByTestId('flow-row-flow-3');
    await expect(waiting).toContainText('Waiting for you');
    await expect(waiting).toHaveAttribute('aria-label', 'Release checklist, Waiting for you');
    await waiting.click();
    await expect(page.getByTestId('flow-attention')).toContainText('Open the run to decide');
    // The engine calls this run "paused"; the history row reads as the Flow does.
    await expect(page.getByTestId('run-row-run-3')).toContainText('Waiting for you');
    await shot(page, 'detail-waiting-dark');
    await page.getByTestId('flow-attention').click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-3' });
    await expect(page.getByTestId('run-summary')).toContainText('Waiting for you');
  });

  test('a failed Flow points at the run that failed', async ({ page }) => {
    const state = await openFlow(page, 'flow-2');
    await expect(page.getByTestId('flow-attention')).toContainText('Last run failed');
    await expect(page.getByTestId('flow-attention')).toContainText('see what went wrong');
    const runs = page.locator('[data-testid^="run-row-"]');
    await expect(runs.first()).toHaveAttribute('data-testid', 'run-row-run-2');
    await expect(runs.first()).toContainText('Failed');
    await shot(page, 'detail-failed-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'detail-failed-light');
    await page.getByTestId('flow-attention').click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-2' });
  });

  test('Run now waits for Frink to be open on the Mac', async ({ page }) => {
    await openFlow(page, 'flow-4', {
      data: { overview: { ...overviewFixture(), executionReady: false } },
    });
    await expect(page.getByText('Open Frink on your Mac to run Flows.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  test('the Enabled switch turns the Flow off', async ({ page }) => {
    const state = await openFlow(page, 'flow-4');
    const toggle = page.getByRole('switch', { name: 'Enabled' });
    await expect(toggle).toBeChecked();
    await toggle.click({ force: true });
    await expect
      .poll(() => lastOf(state, 'setFlowEnabled'))
      .toEqual({ type: 'setFlowEnabled', id: 'flow-4', enabled: false });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('Off. Turn it on to run it.')).toBeVisible();
  });

  test('outlines branches, loops and joins, and expands instructions', async ({ page }) => {
    await openFlow(page, 'flow-2');
    const decision = page.getByTestId('outline-step-decision');
    await expect(decision).toContainText('Needs changes · Returns to Check incoming issues');
    await expect(decision).toContainText('No work needed: Publish summary');
    await expect(page.getByTestId('outline-step-summary')).toContainText('Joins from');
    await expect(page.getByTestId('outline-step-review')).not.toContainText('Then');
    await expect(page.getByText('Version 4. Change steps in Frink on your Mac.')).toBeVisible();
    const show = page.getByRole('button', { name: 'Show instructions for Check incoming issues' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await show.click();
    await expect(page.getByText('Is it actionable?', { exact: true })).toBeVisible();
    const layout = await page
      .locator('[data-testid^="outline-step-"]')
      .evaluateAll((steps) => steps.map((step) => step.scrollWidth - step.clientWidth));
    for (const overflow of layout) expect(overflow).toBeLessThanOrEqual(1);
    await tallShot(page, 'outline-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await tallShot(page, 'outline-light');
  });

  test('says when the steps cannot be shown', async ({ page }) => {
    await openFlow(page, 'flow-4', {
      respond: (input) =>
        input.type === 'flow' ? { ...flowFor('flow-4'), definition: null } : undefined,
    });
    await expect(page.getByText('Steps can’t be shown here')).toBeVisible();
    await expect(page.locator('[data-testid^="outline-step-"]')).toHaveCount(0);
  });

  test('recent runs grow with Show more and open a run', async ({ page }) => {
    const state = await openFlow(page, 'flow-4');
    await expect(page.locator('[data-testid^="run-row-"]')).toHaveCount(5);
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.locator('[data-testid^="run-row-"]')).toHaveCount(15);
    await expect.poll(() => lastOf(state, 'flow')).toMatchObject({ id: 'flow-4', runLimit: 15 });
    await page.getByTestId('run-row-flow-4-run-0').click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'flow-4-run-0' });
  });
});

test.describe('Run detail', () => {
  test('shows a live timeline and polls it every two seconds', async ({ page }) => {
    const state = await openFlow(page, 'flow-1');
    await page.getByTestId('run-row-run-1').click();
    // The live durations tick while the test navigates, so only the minutes are fixed.
    await expect(page.getByTestId('run-summary')).toContainText(/Step 2 of 4 · 9m \d+s/);
    await expect(page.getByTestId('run-step-nr2')).toContainText(/8m \d+s/);
    await expect(page.getByTestId('run-step-nr2')).toContainText('Updating 14 packages');
    await expect(page.getByTestId('run-step-nr3')).toHaveAttribute(
      'aria-label',
      'Run tests, Not started',
    );
    const before = state.requests.filter((request) => request.type === 'run').length;
    await page.clock.runFor(4100);
    await expect
      .poll(() => state.requests.filter((request) => request.type === 'run').length - before)
      .toBeGreaterThanOrEqual(2);
    await tallShot(page, 'run-live-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await tallShot(page, 'run-live-light');
  });

  test('approve and skip send the step’s action token', async ({ page }) => {
    const state = await openFlow(page, 'flow-3', { data: { run: waitingRun() } });
    await page.getByTestId('run-row-run-3').click();
    await expect(page.getByText('Announcement plan')).toBeVisible();
    await expect(page.getByTestId('run-summary')).toContainText('Waiting for you');
    await tallShot(page, 'run-waiting-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await tallShot(page, 'run-waiting-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Approve Plan the announcement' }).click();
    const token = 'e'.repeat(64);
    await expect
      .poll(() => lastOf(state, 'resumeNode'))
      .toEqual({
        type: 'resumeNode',
        runId: 'run-3',
        nodeRunId: 'nr-plan',
        actionToken: token,
        action: 'approve',
      });
    await page.getByRole('button', { name: 'Skip Plan the announcement' }).click();
    await expect
      .poll(() => lastOf(state, 'resumeNode'))
      .toMatchObject({ nodeRunId: 'nr-plan', actionToken: token, action: 'skip' });
    await page.getByRole('button', { name: 'Open chat for Plan the announcement' }).click();
    await expect(page.getByTestId('run-step-nr-plan')).toBeHidden();
  });

  test('decisions wait for Frink to be open on the Mac', async ({ page }) => {
    const state = await openFlow(page, 'flow-3', {
      data: { run: waitingRun(), overview: { ...overviewFixture(), executionReady: false } },
    });
    await page.getByTestId('flow-attention').click();
    const step = page.getByTestId('run-step-nr-plan');
    await expect(step).toContainText('Open Frink on your Mac to continue this run.');
    await expect(
      page.getByRole('button', { name: 'Approve Plan the announcement' }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Skip Plan the announcement' })).toBeDisabled();
    await tallShot(page, 'run-not-ready-dark');
    expect(lastOf(state, 'resumeNode')).toBeUndefined();
  });

  test('a decision that fails explains itself beside its buttons', async ({ page }) => {
    await openFlow(page, 'flow-3', {
      data: { run: waitingRun() },
      respond: (input) =>
        input.type === 'resumeNode'
          ? new Error('This step has already moved on. Pull down to refresh.')
          : perFlow(input),
    });
    await page.getByTestId('run-row-run-3').click();
    await page.getByRole('button', { name: 'Approve Plan the announcement' }).click();
    await expect(page.getByTestId('run-step-nr-plan')).toContainText(
      'This step has already moved on.',
    );
    await tallShot(page, 'run-decision-error-dark');
  });

  test('stopping a run asks first', async ({ page }) => {
    const state = await openFlow(page, 'flow-1');
    await page.getByTestId('run-row-run-1').click();
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await expect(page.getByText('Stop this run?')).toBeVisible();
    await tallShot(page, 'run-stop-confirm-dark');
    await page.getByRole('button', { name: 'Keep running' }).click();
    await expect(page.getByText('Stop this run?')).toBeHidden();
    await expect.poll(() => lastOf(state, 'cancelRun')).toBeUndefined();
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await page.getByRole('button', { name: 'Stop run now' }).click();
    await expect.poll(() => lastOf(state, 'cancelRun')).toEqual({ type: 'cancelRun', id: 'run-1' });
  });

  test('a finished run has no Stop', async ({ page }) => {
    await openFlow(page, 'flow-4', {
      data: {
        run: {
          ...waitingRun(),
          status: 'completed',
          completedAt: new Date(Date.parse('2026-09-29T14:30:00Z') - 60_000).toISOString(),
          nodes: waitingRun().nodes.map((node) => ({
            ...node,
            status: 'completed',
            actions: [],
            completedAt: node.completedAt ?? node.startedAt,
          })),
        },
      },
    });
    await page.getByTestId('run-row-flow-4-run-0').click();
    await expect(page.getByTestId('run-summary')).toContainText('Done');
    // A finished decision keeps one calm line: its heading, not the list run together.
    const plan = page.getByTestId('run-step-nr-plan');
    await expect(plan).toContainText('Announcement plan');
    await expect(plan).not.toContainText('Post the release notes');
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
    await tallShot(page, 'run-done-dark');
  });
});
