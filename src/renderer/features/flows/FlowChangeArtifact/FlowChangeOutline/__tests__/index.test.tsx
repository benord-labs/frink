// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowSemanticChange } from '../../../../../../shared/types/flows/flow-change-presentation';
import type {
  FlowChangeOutlineModel,
  FlowOutlineStep,
} from '../../../../../lib/flows/flow-change-outline';
import { FlowChangeOutline } from '..';

function change(
  operationIndex: number,
  overrides: Partial<FlowSemanticChange> = {},
): FlowSemanticChange {
  return {
    operationIndex,
    action: 'add',
    kind: 'node',
    status: 'applied',
    label: `Change ${operationIndex}`,
    ...overrides,
  };
}

function step(
  id: string,
  label: string,
  overrides: Partial<FlowOutlineStep> = {},
): FlowOutlineStep {
  return {
    id: `step:${id}`,
    nodeId: id,
    label,
    blockType: 'agent',
    blockTypeLabel: 'Agent',
    relationChanges: [],
    changes: [],
    branches: [],
    ...overrides,
  };
}

const OUTLINE: FlowChangeOutlineModel = {
  heading: 'Resulting flow',
  scope: 'full',
  routes: [
    {
      id: 'route:start',
      changes: [],
      steps: [
        step('start', 'Run manually', {
          blockType: 'manual_trigger',
          blockTypeLabel: 'Manual trigger',
          changes: [change(0, { detail: 'Step', nodeId: 'start' })],
        }),
        step('review', 'Review changes', {
          relationBefore: 'Then',
          relationChanges: [
            change(1, {
              kind: 'edge',
              edgeId: 'start-review',
              label: 'Run manually → Review changes',
            }),
          ],
          changes: [
            change(2, {
              action: 'update',
              detail: 'Step setup',
              nodeId: 'review',
            }),
          ],
          branches: [
            {
              id: 'route:yes',
              label: 'If yes',
              changes: [
                change(3, {
                  kind: 'edge',
                  edgeId: 'review-draft',
                  label: 'Review changes → Draft report',
                }),
              ],
              steps: [step('draft', 'Draft report', { relationBefore: 'If yes' })],
              terminal: {
                kind: 'join',
                nodeId: 'publish',
                label: 'Publish',
                text: 'Joins at Publish',
                changes: [],
              },
            },
            {
              id: 'route:no',
              label: 'If no',
              changes: [],
              steps: [step('skip', 'Skip report', { relationBefore: 'If no' })],
              terminal: {
                kind: 'loop',
                nodeId: 'review',
                label: 'Review changes',
                text: 'Loops back to Review changes',
                relationLabel: 'Retry',
                changes: [
                  change(4, {
                    action: 'remove',
                    kind: 'edge',
                    status: 'failed',
                    detail: 'Route',
                    edgeId: 'skip-review',
                    label: 'Skip report → Review changes',
                  }),
                ],
              },
            },
          ],
        }),
      ],
    },
  ],
  settingsChanges: [],
  unplacedChanges: [],
  omittedNodeCount: 0,
  omittedRouteCount: 0,
  synopsis: 'Run manually → Review changes',
  totalNodeCount: 4,
  branchCount: 2,
};

describe('FlowChangeOutline', () => {
  afterEach(cleanup);

  it('renders a native, branch-aware hierarchy without repeating applied status', () => {
    const { container } = render(<FlowChangeOutline outline={OUTLINE} />);

    expect(screen.getByRole('region', { name: 'How this Flow runs' })).toBeTruthy();
    expect(screen.getByText('4 steps, 2 paths')).toBeTruthy();
    expect(screen.queryByText('Next')).toBeNull();
    expect(screen.getByText('Start the flow from the app with Run')).toBeTruthy();
    expect(screen.getAllByText('Runs the agent instructions')).toHaveLength(3);
    expect(screen.getAllByText('If yes')).toHaveLength(1);
    expect(screen.getAllByText('If no')).toHaveLength(1);
    expect(screen.getByText('Joins at Publish')).toBeTruthy();
    expect(screen.getByText('Retry: Loops back to Review changes')).toBeTruthy();
    expect(
      screen.getByText('Review changes').closest('[data-slot="flow-change-step"]')?.textContent,
    ).toContain('Updated: step settings');
    expect(screen.getByText('Could not remove this connection')).toBeTruthy();
    expect(screen.queryByText('Added to this Flow')).toBeNull();
    expect(screen.queryByText('Applied')).toBeNull();
    expect(container.querySelectorAll('[data-slot="flow-change-marker"]')).toHaveLength(4);
    expect(container.querySelector('[data-slot="flow-change-marker"]')?.textContent).toBe('');
    expect(container.querySelectorAll('ol').length).toBeGreaterThan(1);
    expect(container.querySelectorAll('[role="list"]')).not.toHaveLength(0);
    expect(container.querySelectorAll('[role="listitem"]')).not.toHaveLength(0);
    expect(container.querySelector('[role="tree"]')).toBeNull();
  });

  it('renders settings and topology exceptions in separate plain-language sections', () => {
    render(
      <FlowChangeOutline
        outline={{
          ...OUTLINE,
          heading: 'Changes not applied',
          scope: 'changes-only',
          routes: [],
          totalNodeCount: 2,
          branchCount: 0,
          settingsChanges: [
            change(5, {
              action: 'update',
              kind: 'settings',
              label: 'Flow briefing',
            }),
          ],
          unplacedChanges: [
            change(6, {
              action: 'remove',
              kind: 'node',
              status: 'unknown',
              label: 'Retired task',
            }),
          ],
        }}
      />,
    );

    expect(screen.getByRole('region', { name: 'Changes not applied' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Flow settings' })).toBeTruthy();
    expect(screen.getByText('Flow briefing')).toBeTruthy();
    expect(screen.getByText('Updated: flow settings')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
    expect(screen.getByText('Retired task')).toBeTruthy();
    expect(screen.getByText('Could not confirm removal from this Flow')).toBeTruthy();
    expect(screen.queryByText('2 steps')).toBeNull();
  });

  it('anchors omitted-step copy to the last visible step', () => {
    render(
      <FlowChangeOutline
        outline={{
          ...OUTLINE,
          scope: 'neighborhood',
          routes: [
            {
              id: 'route:review',
              changes: [],
              steps: [step('review', 'Review changes', { omittedAfter: 2 })],
            },
          ],
          omittedNodeCount: 2,
          totalNodeCount: 3,
          branchCount: 0,
        }}
      />,
    );

    expect(screen.getByText('1 of 3 steps')).toBeTruthy();
    expect(screen.getByText('2 more steps continue after Review changes')).toBeTruthy();
    expect(screen.queryByText('+2')).toBeNull();
  });

  it('announces routes omitted by the bounded outline', () => {
    render(<FlowChangeOutline outline={{ ...OUTLINE, omittedRouteCount: 2 }} />);

    expect(screen.getByText('2 more routes not shown')).toBeTruthy();
  });

  it('describes a successfully removed unplaced step without implying a problem', () => {
    render(
      <FlowChangeOutline
        outline={{
          ...OUTLINE,
          routes: [],
          totalNodeCount: 0,
          branchCount: 0,
          unplacedChanges: [
            change(7, {
              action: 'remove',
              kind: 'node',
              label: 'Retired task',
            }),
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Removed from Flow' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).toBeNull();
    expect(screen.getByText('Removed from this Flow')).toBeTruthy();
  });
});
