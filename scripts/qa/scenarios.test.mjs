import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { prepare as prepareHtmlArtifactPreview } from '../../.qavis/scenarios/html-artifact-preview.mjs';
import { prepare as prepareModelCatalog } from '../../.qavis/scenarios/model-catalog.mjs';
import { prepare as preparePlanIndicator } from '../../.qavis/scenarios/plan-approval-indicator.mjs';
import { prepare as prepareBatchMemberDelete } from '../../.qavis/scenarios/sidebar-batch-member-delete.mjs';
import { prepare as preparePluginNodeSteps } from '../../.qavis/scenarios/plugin-node-steps.mjs';
import { prepare as prepareSettingsSeam } from '../../.qavis/scenarios/settings-sidebar-seam.mjs';
import { prepare as prepareHistoryFilter } from '../../.qavis/scenarios/work-queue-history-filter.mjs';

const WORK_QUEUE_BUTTON_NAME = /^Work Queue\./;
const FIXTURE_PROJECT_NAME = /QA Fixture/;

describe('qavis durable scenarios', () => {
  it('opens the seeded plugin-node flow on its call-tool step, leaving the fields to the driver', async () => {
    const flowsNav = { click: vi.fn(async () => {}) };
    const step = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const flowRow = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const displayName = { waitFor: vi.fn(async () => {}) };
    const getByRole = vi.fn((role, options) =>
      role === 'button' && options?.name === 'Flows' ? flowsNav : step,
    );

    await preparePluginNodeSteps({
      page: { getByRole, getByText: vi.fn(() => flowRow), getByLabel: vi.fn(() => displayName) },
    });

    expect(getByRole).toHaveBeenNthCalledWith(1, 'button', { name: 'Flows', exact: true });
    expect(flowRow.click).toHaveBeenCalledOnce();
    expect(getByRole).toHaveBeenNthCalledWith(2, 'button', {
      name: /^Step \d+: Call any PostHog tool$/,
    });
    expect(step.click).toHaveBeenCalledOnce();
    expect(displayName.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 30_000 });
  });

  it('opens Settings through its accessible control and waits for the target navigation', async () => {
    const button = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const navigation = { waitFor: vi.fn(async () => {}) };
    const getByRole = vi.fn((role) => (role === 'button' ? button : navigation));

    await prepareSettingsSeam({ page: { getByRole } });

    expect(getByRole).toHaveBeenNthCalledWith(1, 'button', {
      name: 'Settings',
      exact: true,
    });
    expect(button.click).toHaveBeenCalledOnce();
    expect(getByRole).toHaveBeenNthCalledWith(2, 'navigation', {
      name: 'Settings navigation',
      exact: true,
    });
    expect(navigation.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 30_000 });
  });

  it('expands the seeded batch group and opens one member row menu, leaving the delete to the driver', async () => {
    const header = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const menuButton = { click: vi.fn(async () => {}) };
    const row = {
      waitFor: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      getByRole: vi.fn(() => menuButton),
    };
    const locator = vi.fn((selector) =>
      selector === '.sidebar-batch-tree-header' ? { first: () => header } : row,
    );

    await prepareBatchMemberDelete({ page: { locator } });

    expect(locator).toHaveBeenNthCalledWith(1, '.sidebar-batch-tree-header', {
      hasText: 'Batch QA flow',
    });
    expect(header.click).toHaveBeenCalledTimes(1);
    expect(locator).toHaveBeenLastCalledWith('#sidebar-item-qa-fixture-chat-batch-member-a');
    expect(row.getByRole).toHaveBeenCalledWith('button', { name: 'Chat actions' });
    expect(menuButton.click).toHaveBeenCalledTimes(1);
  });

  it('waits only for the seeded plan-ready chat row, not for the changed indicator', async () => {
    const row = { waitFor: vi.fn(async () => {}) };
    const locator = vi.fn(() => row);

    await preparePlanIndicator({ page: { locator } });

    expect(locator).toHaveBeenCalledWith('#sidebar-item-qa-fixture-chat-seeded');
    expect(row.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 30_000 });
  });

  it('opens the seeded chat and leaves the collapsed artifact for the QA driver', async () => {
    const projectRow = {
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => 'false'),
      click: vi.fn(async () => {}),
    };
    const openChat = { click: vi.fn(async () => {}) };
    const chatRow = {
      waitFor: vi.fn(async () => {}),
      getByRole: vi.fn(() => ({ first: () => openChat })),
    };
    const visible = { waitFor: vi.fn(async () => {}) };
    const runArtifact = { waitFor: vi.fn(async () => {}) };
    const getByRole = vi.fn((role) => (role === 'treeitem' ? projectRow : runArtifact));

    await prepareHtmlArtifactPreview({
      page: { locator: () => chatRow, getByText: () => visible, getByRole },
    });

    expect(getByRole).toHaveBeenNthCalledWith(1, 'treeitem', { name: FIXTURE_PROJECT_NAME });
    expect(projectRow.click).toHaveBeenCalledOnce();
    expect(openChat.click).toHaveBeenCalledOnce();
    expect(getByRole).toHaveBeenNthCalledWith(2, 'button', {
      name: 'Run artifact',
      exact: true,
    });
    expect(runArtifact.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 30_000 });
  });

  it('opens the seeded chat and waits for the closed model picker trigger, not the changed catalog', async () => {
    const projectRow = {
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => 'false'),
      click: vi.fn(async () => {}),
    };
    const openChat = { click: vi.fn(async () => {}) };
    const chatRow = {
      waitFor: vi.fn(async () => {}),
      getByRole: vi.fn(() => ({ first: () => openChat })),
    };
    const visible = { waitFor: vi.fn(async () => {}) };
    const modelTrigger = { waitFor: vi.fn(async () => {}) };
    const getByRole = vi.fn((role) => (role === 'treeitem' ? projectRow : modelTrigger));

    await prepareModelCatalog({
      page: { locator: () => chatRow, getByText: () => visible, getByRole },
    });

    expect(getByRole).toHaveBeenNthCalledWith(1, 'treeitem', { name: FIXTURE_PROJECT_NAME });
    expect(projectRow.click).toHaveBeenCalledOnce();
    expect(openChat.click).toHaveBeenCalledOnce();
    expect(getByRole).toHaveBeenNthCalledWith(2, 'button', { name: /^Sonnet 4\.6$/ });
    expect(modelTrigger.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 30_000 });
  });

  it('registers model-catalog in the catalog: resolvable module, three claims, the picker globs', async () => {
    const catalog = JSON.parse(
      await readFile(new URL('../../.qavis/scenarios.json', import.meta.url), 'utf8'),
    );
    const entry = catalog.scenarios.find((scenario) => scenario.id === 'model-catalog');
    expect(entry).toBeDefined();
    expect(existsSync(new URL(`../../${entry.module}`, import.meta.url))).toBe(true);
    expect(typeof prepareModelCatalog).toBe('function');
    expect(entry.claims).toHaveLength(3);
    for (const claim of entry.claims) expect(claim.length).toBeGreaterThan(40);
    expect(entry.match).toEqual(
      expect.arrayContaining([
        'src/shared/lib/models/**',
        'src/renderer/features/agents/components/model-selector.tsx',
        'src/renderer/features/agents/components/ModelPicker/**',
      ]),
    );
  });

  it('opens the Work Queue History surface and waits for both terminal fixtures', async () => {
    const workQueueButton = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const historyButton = { waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    const historyHeading = { waitFor: vi.fn(async () => {}) };
    const completedRow = { waitFor: vi.fn(async () => {}) };
    const cancelledRow = { waitFor: vi.fn(async () => {}) };
    const getByRole = vi.fn((role, options) => {
      if (role === 'heading') return historyHeading;
      return typeof options.name === 'string' ? historyButton : workQueueButton;
    });
    const getByText = vi.fn((text) =>
      text === 'Completed history example' ? completedRow : cancelledRow,
    );

    await prepareHistoryFilter({ page: { getByRole, getByText } });

    expect(getByRole).toHaveBeenNthCalledWith(1, 'button', { name: WORK_QUEUE_BUTTON_NAME });
    expect(getByRole).toHaveBeenNthCalledWith(2, 'button', {
      name: 'View task history',
      exact: true,
    });
    expect(getByRole).toHaveBeenNthCalledWith(3, 'heading', {
      name: 'History',
      exact: true,
    });
    expect(getByText).toHaveBeenNthCalledWith(1, 'Completed history example', { exact: true });
    expect(getByText).toHaveBeenNthCalledWith(2, 'Cancelled history example', { exact: true });
    expect(workQueueButton.click).toHaveBeenCalledOnce();
    expect(historyButton.click).toHaveBeenCalledOnce();
  });
});
