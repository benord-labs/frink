import { expect, test, type Page } from '@playwright/test';
import type { MobileFlowDefinition } from '../../src/shared/types/remote/mobile';

const host = 'https://flow-preview.example.test';
const flow = {
  id: 'flow',
  name: 'Morning issue triage',
  description: 'Turn incoming issues into clear next steps.',
  enabled: true,
  trigger: 'schedule_trigger',
  latestRunId: 'run',
  status: 'completed',
};
const definition: MobileFlowDefinition = {
  versionNumber: 4,
  nodes: [
    {
      id: 'trigger',
      label: 'Every weekday',
      blockType: 'schedule_trigger',
      parentId: null,
      instructions: null,
    },
    {
      id: 'review',
      label: 'Check incoming issues',
      blockType: 'agent',
      parentId: null,
      instructions:
        'Review new issues and check:\n\n- Is it actionable?\n- Can we reproduce it?\n\nKeep the summary **short and useful**.',
    },
    {
      id: 'decision',
      label: 'Ready to proceed?',
      blockType: 'condition',
      parentId: null,
      instructions: null,
    },
    {
      id: 'prepare',
      label: 'Prepare next steps for the issues that need a detailed investigation',
      blockType: 'agent',
      parentId: null,
      instructions: 'Prepare a concise plan.',
    },
    {
      id: 'summary',
      label: 'Publish summary',
      blockType: 'agent',
      parentId: null,
      instructions: null,
    },
  ],
  edges: [
    { id: 'a', source: 'trigger', target: 'review', label: null, sourceHandle: null },
    { id: 'b', source: 'review', target: 'decision', label: null, sourceHandle: null },
    { id: 'c', source: 'decision', target: 'prepare', label: 'Ready', sourceHandle: 'true' },
    {
      id: 'd',
      source: 'decision',
      target: 'review',
      label: 'Needs changes',
      sourceHandle: 'false',
    },
    { id: 'e', source: 'prepare', target: 'summary', label: null, sourceHandle: null },
    {
      id: 'f',
      source: 'decision',
      target: 'summary',
      label: 'No work needed',
      sourceHandle: 'skip',
    },
  ],
};

async function connect(page: Page, current: MobileFlowDefinition | null = definition) {
  await page.route(`${host}/**`, async (route) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,authorization',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().endsWith('/pair'))
      return route.fulfill({
        headers,
        json: {
          token: 'b'.repeat(43),
          deviceId: 'preview-phone',
          machineName: 'Benji’s Mac',
          apiVersion: 1,
        },
      });
    const input = route.request().postDataJSON();
    const responses: Record<string, unknown> = {
      overview: {
        machineName: 'Benji’s Mac',
        executionReady: true,
        questions: [],
        permissions: [],
        queue: [],
      },
      flows: [
        flow,
        {
          ...flow,
          id: 'audit',
          name: 'Weekly dependency audit',
          description: 'Review package updates.',
          enabled: false,
        },
      ],
      flow: {
        flow,
        definition: current,
        runs: [{ id: 'run', status: 'completed', startedAt: '2026-09-28T08:30:00Z' }],
      },
      run: {
        id: 'run',
        flowId: flow.id,
        flowName: flow.name,
        status: 'completed',
        startedAt: '2026-09-28T08:30:00Z',
        nodes: [
          {
            id: 'original',
            label: 'Original review before the Flow was edited',
            status: 'completed',
            detail: '## Complete\n\nReviewed the original set of issues.',
            actions: [],
            actionToken: 'c'.repeat(64),
            chatId: null,
            subChatId: null,
          },
        ],
      },
    };
    return route.fulfill({ headers, json: { data: responses[input.type] ?? { ok: true } } });
  });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Pairing code', exact: true })
    .fill(JSON.stringify({ version: 1, url: host, code: 'a'.repeat(43) }));
  await page.getByRole('button', { name: 'Connect to Frink', exact: true }).click();
  await page.getByRole('tab', { name: 'Flows', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search Flows' })).toBeVisible();
}

test('searches Flow names and descriptions and recovers from no matches', async ({ page }) => {
  await connect(page);
  const search = page.getByRole('textbox', { name: 'Search Flows' });
  await search.fill('package');
  await expect(page.getByText('Weekly dependency audit', { exact: true })).toBeVisible();
  await expect(page.getByText(flow.name, { exact: true })).toHaveCount(0);
  await search.fill('unmatched');
  await expect(
    page.getByText('No Flows match “unmatched”. Try another name or description.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByText(flow.name, { exact: true })).toBeVisible();
});

for (const scheme of ['dark', 'light'] as const) {
  test(`shows the complete current definition, branches and loops in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: scheme === 'light' ? 320 : 390, height: 844 });
    await connect(page);
    await page.getByText(flow.name, { exact: true }).click();
    await expect(page.getByText('Current definition · Version 4 · 5 steps')).toBeVisible();
    await expect(page.getByTestId('definition-step-decision')).toContainText(
      'Needs changes · Returns to Check incoming issues',
    );
    await expect(page.getByTestId('definition-step-decision')).toContainText(
      'No work needed: Publish summary',
    );
    await expect(page.getByTestId('definition-step-summary')).toContainText('Joins from');
    const instructions = page.getByRole('button', {
      name: 'Show instructions for Check incoming issues',
    });
    await expect(instructions).toHaveAttribute('aria-expanded', 'false');
    await instructions.click();
    await expect(
      page.getByRole('button', { name: 'Hide instructions for Check incoming issues' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Is it actionable?', { exact: true })).toBeVisible();
    const layout = await page
      .locator('[data-testid^="definition-step-"]')
      .evaluateAll((steps) =>
        steps.map((step) => ({ width: step.scrollWidth, client: step.clientWidth })),
      );
    for (const step of layout) expect(step.width).toBeLessThanOrEqual(step.client + 1);
    await page.screenshot({
      path: `.expo/preview-02/flow-definition-${scheme}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Hide instructions for Check incoming issues' }).click();
    await page.getByTestId('definition-step-summary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.expo/preview-02/flow-branches-${scheme}.png`, fullPage: true });
    await page.getByText('Recent runs', { exact: true }).scrollIntoViewIfNeeded();
    await page
      .getByRole('button')
      .filter({ hasText: /9\/28\/2026|28\/09\/2026|Sep 28/ })
      .click();
    await expect(page.getByText('Original review before the Flow was edited', { exact: true })).toBeVisible();
    await expect(page.getByText('How it runs', { exact: true })).not.toBeVisible();
  });
}

test('displays an unavailable definition without inventing steps', async ({ page }) => {
  await connect(page, null);
  await page.getByText(flow.name, { exact: true }).click();
  await expect(
    page.getByText(
      'This Flow can’t be shown on your phone. It may be unfinished or too large. Open it on your computer to see every step.',
    ),
  ).toBeVisible();
  await expect(page.locator('[data-testid^="definition-step-"]')).toHaveCount(0);
});
