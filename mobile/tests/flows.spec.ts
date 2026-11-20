import { openDestination } from './fixtures/navigation';
import { expect, test, type Page } from '@playwright/test';
import { held, openApp, type AppState } from './fixtures/app';
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
  await openDestination(page, 'Flows');
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
  test('is one list: runs under way now, then every Flow', async ({ page }) => {
    await openFlows(page);
    await expect(page.getByRole('tab', { name: 'Library', exact: true })).toHaveCount(0);
    await expect(page.getByText('Recent results')).toHaveCount(0);
    const ids = (prefix: string) =>
      page
        .locator(`[data-testid^="${prefix}"]`)
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
    // Every unfinished run is "now", including the one waiting on you.
    expect(await ids('flow-now-')).toEqual(['flow-now-flow-1', 'flow-now-flow-3']);
    await expect(page.getByTestId('flow-now-flow-1')).toContainText('Running');
    await expect(page.getByTestId('flow-now-flow-3')).toContainText('Waiting for you');
    await expect(page.getByTestId('flows-needs-you')).toContainText(/^\d+ needs? you/);
    await expect(page.getByRole('heading', { name: /^All Flows/ })).toContainText('5');
    expect(await ids('flow-row-')).toEqual([
      'flow-row-flow-1',
      'flow-row-flow-2',
      'flow-row-flow-3',
      'flow-row-flow-4',
      'flow-row-flow-5',
    ]);
    await expect(page.getByTestId('flow-row-flow-4')).toContainText('Summarises support email');
    await expect(page.getByTestId('flow-row-flow-4')).toContainText('7h');
    await expect(page.getByTestId('flow-row-flow-2')).toHaveAttribute(
      'aria-label',
      'Nightly triage, Failed',
    );
    // An off Flow is dimmed rather than labelled.
    await expect(page.getByTestId('flow-row-flow-5')).toHaveCSS('opacity', '0.55');
    await expect(page.getByTestId('flow-row-flow-5')).not.toContainText(/\bOff\b/);
    await expect(page.getByTestId('flow-row-flow-4')).toHaveCSS('opacity', '1');
    await shot(page, 'list-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'list-light');
  });

  test('a Now row opens its run; a Flow row opens the Flow', async ({ page }) => {
    const state = await openFlows(page);
    await page.getByTestId('flow-now-flow-1').click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-1' });
    await page.getByRole('link', { name: /back/i }).filter({ visible: true }).click();
    await page.getByTestId('flow-row-flow-2').click();
    await expect.poll(() => lastOf(state, 'flow')).toMatchObject({ type: 'flow', id: 'flow-2' });
    expect(lastOf(state, 'startFlow')).toBeUndefined();
  });

  test('the needs-you row switches to the Queue', async ({ page }) => {
    await openFlows(page);
    await page.getByTestId('flows-needs-you').click();
    await expect(
      page.getByRole('heading', { name: 'Queue', exact: true }).filter({ visible: true }),
    ).toBeVisible();
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
    await expect(page.getByText(/Create a flow in Frink on your Mac/)).toBeVisible();
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
    // The state is said once, on the run's history row.
    await expect(page.getByText('Running', { exact: true }).filter({ visible: true })).toHaveCount(
      1,
    );
    await expect(page.getByTestId('run-row-run-1')).toContainText('Running');
    await shot(page, 'detail-running-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'detail-running-light');
    await page.getByRole('button', { name: 'View current run' }).click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-1' });
  });

  test('a Flow waiting on you says so and opens the run to decide', async ({ page }) => {
    const state = await openFlows(page, { data: { run: waitingRun() } });
    await expect(page.getByTestId('flow-row-flow-3')).toHaveAttribute(
      'aria-label',
      'Release checklist, Waiting for you',
    );
    await page.getByTestId('flow-row-flow-3').click();
    await expect(page.getByTestId('flow-current-run')).toBeVisible();
    await expect(
      page.getByText('Waiting for you', { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View current run' })).toHaveCount(1);
    // The engine calls this run "paused"; the history row reads as the Flow does.
    await expect(page.getByTestId('run-row-run-3')).toContainText('Waiting for you');
    await shot(page, 'detail-waiting-dark');
    await page.getByRole('button', { name: 'View current run' }).click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-3' });
    await expect(page.getByTestId('run-summary')).toContainText('Waiting for you');
  });

  test('a failed Flow points at the run that failed', async ({ page }) => {
    const state = await openFlow(page, 'flow-2');
    // The failure is said once, on its run; Run now stays the primary row.
    await expect(page.getByTestId('flow-attention')).toHaveCount(0);
    await expect(page.getByTestId('flow-run-now')).toBeVisible();
    const runs = page.locator('[data-testid^="run-row-"]');
    await expect(runs.first()).toHaveAttribute('data-testid', 'run-row-run-2');
    await expect(runs.first()).toContainText('Failed');
    await shot(page, 'detail-failed-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'detail-failed-light');
    await runs.first().click();
    await expect.poll(() => lastOf(state, 'run')).toEqual({ type: 'run', id: 'run-2' });
  });

  test('a missing current-run ID blocks starting over live work', async ({ page }) => {
    await openFlow(page, 'flow-1', {
      respond: (input) =>
        input.type === 'flow'
          ? {
              ...flowFor('flow-1'),
              flow: { ...flowFor('flow-1').flow, latestRunId: null },
            }
          : undefined,
    });
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    await expect(page.getByTestId('flow-run-now')).toContainText(
      'Refresh to find the current run.',
    );
  });

  test('Run now waits for Frink to be open on the Mac', async ({ page }) => {
    const state = await openFlow(page, 'flow-4', {
      data: { overview: { ...overviewFixture(), executionReady: false } },
    });
    await expect(page.getByTestId('flow-run-now')).toContainText(
      'Open Frink on your Mac to run Flows.',
    );
    await page.getByTestId('flow-run-now').click({ force: true });
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    expect(lastOf(state, 'startFlow')).toBeUndefined();
  });

  test('the Enabled switch in the navigation bar turns the Flow off', async ({ page }) => {
    const state = await openFlow(page, 'flow-4');
    const toggle = page.getByRole('switch', { name: 'Enabled' }).filter({ visible: true });
    await expect(toggle).toBeChecked();
    await toggle.click({ force: true });
    await expect
      .poll(() => lastOf(state, 'setFlowEnabled'))
      .toEqual({ type: 'setFlowEnabled', id: 'flow-4', enabled: false });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('flow-run-now')).toContainText('Turn this Flow on to run it.');
  });

  test('outlines branches, loops and joins, and expands instructions', async ({ page }) => {
    await openFlow(page, 'flow-2');
    await expect(page.locator('[data-testid^="outline-step-"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show steps', exact: true }).click();
    const decision = page.getByTestId('outline-step-decision');
    await expect(decision).toContainText('Needs changes · Returns to Check incoming issues');
    await expect(decision).toContainText('No work needed: Publish summary');
    await expect(page.getByTestId('outline-step-summary')).toContainText('Joins from');
    await expect(page.getByTestId('outline-step-review')).not.toContainText('Then');
    await expect(page.getByText('Version 4. Change steps in Frink on your Mac.')).toBeVisible();
    const show = page.getByRole('button', { name: 'Show instructions for Check incoming issues' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await show.click();
    await expect(page.getByTestId('outline-step-review')).toContainText('Is it actionable?');
    await expect(
      page.getByRole('button', { name: 'Hide instructions for Check incoming issues' }),
    ).toHaveAttribute('aria-expanded', 'true');
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
    await page.getByRole('button', { name: 'Show steps', exact: true }).click();
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
    await expect(page.locator('[data-testid^="run-step-"]').first()).toHaveAttribute(
      'data-testid',
      'run-step-nr-plan',
    );
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

  test('a run with only a waiting step does not promise a first step', async ({ page }) => {
    const run = waitingRun();
    run.nodes = run.nodes.filter((node) => node.id === 'nr-plan');
    await openFlow(page, 'flow-3', { data: { run } });
    await page.getByRole('button', { name: 'View current run' }).click();
    await expect(page.getByText('Announcement plan')).toBeVisible();
    await expect(page.getByText('Timeline', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Frink is getting the first step ready.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve Plan the announcement' })).toBeVisible();
  });

  test('decisions wait for Frink to be open on the Mac', async ({ page }) => {
    const state = await openFlow(page, 'flow-3', {
      data: { run: waitingRun(), overview: { ...overviewFixture(), executionReady: false } },
    });
    await page.getByRole('button', { name: 'View current run' }).click();
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

  test('Stop sits in the navigation bar and asks first', async ({ page }) => {
    const state = await openFlow(page, 'flow-1');
    await page.getByTestId('run-row-run-1').click();
    const stop = page
      .getByRole('button', { name: 'Stop run', exact: true })
      .filter({ visible: true });
    const prompts: string[] = [];
    page.once('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await stop.click();
    await expect.poll(() => prompts).toEqual(['Stop run?\n\nStopping ends the whole Flow run.']);
    expect(lastOf(state, 'cancelRun')).toBeUndefined();
    page.once('dialog', (dialog) => void dialog.accept());
    await stop.click();
    await expect.poll(() => lastOf(state, 'cancelRun')).toEqual({ type: 'cancelRun', id: 'run-1' });
  });

  test('Stop waits while a decision is being sent', async ({ page }) => {
    const answer = held();
    const state = await openFlow(page, 'flow-3', {
      data: { run: waitingRun() },
      respond: (input) => (input.type === 'resumeNode' ? answer.promise : perFlow(input)),
    });
    await page.getByTestId('run-row-run-3').click();
    const stop = page
      .getByRole('button', { name: 'Stop run', exact: true })
      .filter({ visible: true });
    await expect(stop).toBeEnabled();
    await page.getByRole('button', { name: 'Approve Plan the announcement' }).click();
    await expect.poll(() => lastOf(state, 'resumeNode')).toMatchObject({ action: 'approve' });
    await expect(stop).toBeDisabled();
    answer.release();
    await expect(stop).toBeEnabled();
  });

  test('Open Flow goes from a run to its Flow', async ({ page }) => {
    const state = await openFlows(page);
    await page.getByTestId('flow-now-flow-1').click();
    await page.getByRole('button', { name: 'Open Flow' }).filter({ visible: true }).click();
    await expect.poll(() => lastOf(state, 'flow')).toMatchObject({ type: 'flow', id: 'flow-1' });
    await expect(page.getByTestId('flow-current-run')).toBeVisible();
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
    await page.getByRole('button', { name: 'Show result for Plan the announcement' }).click();
    await expect(plan).toContainText('Post the release notes');
    await expect(plan).toContainText('Email beta testers');
    await page.getByRole('button', { name: 'Hide result for Plan the announcement' }).click();
    await expect(plan).not.toContainText('Post the release notes');
    await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toHaveCount(0);
    await tallShot(page, 'run-done-dark');
  });
});
