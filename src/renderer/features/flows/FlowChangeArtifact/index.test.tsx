// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowChangePresentation } from '../../../../shared/types/flows/flow-change-presentation';
import { FlowChangeArtifact } from './index';

const PRESENTATION: FlowChangePresentation = {
  flowId: 'internal-flow-id',
  name: 'Release train',
  mode: 'update',
  phase: 'partial',
  baseVersionNumber: 3,
  versionNumber: 4,
  warningCount: 2,
  graph: {
    nodes: [
      {
        id: 'trigger',
        label: 'Launch',
        blockType: 'manual_trigger',
      },
      {
        id: 'agent',
        label: 'Write release',
        blockType: 'agent',
        changeAction: 'update',
        changeStatus: 'applied',
      },
    ],
    edges: [
      {
        id: 'edge',
        source: 'trigger',
        target: 'agent',
        changeAction: 'remove',
        changeStatus: 'failed',
      },
    ],
  },
  changes: [
    {
      operationIndex: 0,
      action: 'update',
      kind: 'node',
      status: 'applied',
      label: 'Write release',
      detail: 'Instructions',
      nodeId: 'agent',
    },
    {
      operationIndex: 1,
      action: 'remove',
      kind: 'edge',
      status: 'failed',
      label: 'Launch → Write release',
      edgeId: 'edge',
    },
  ],
};

describe('FlowChangeArtifact', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rests as a compact receipt and expands into the saved Flow hierarchy', () => {
    render(<FlowChangeArtifact presentation={PRESENTATION} />);

    expect(screen.getByRole('region', { name: 'Release train' })).toBeTruthy();
    expect(screen.getByText('Flow partly updated')).toBeTruthy();
    expect(screen.getByText('Launch → Write release. 1 applied, 1 failed')).toBeTruthy();
    expect(screen.getByText('Version 4 · 2 steps · 2 changes · 2 warnings')).toBeTruthy();
    expect(screen.queryByText('Change audit')).toBeNull();
    expect(screen.queryByText('Affected topology')).toBeNull();
    expect(screen.queryByText('Technical details')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));

    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();
    expect(screen.getByText('Launch')).toBeTruthy();
    expect(screen.getByText('Start the flow from the app with Run')).toBeTruthy();
    expect(screen.getByText('Write release')).toBeTruthy();
    expect(screen.getByText('Runs the agent instructions')).toBeTruthy();
    expect(screen.queryByText('Next')).toBeNull();
    expect(
      screen.getByText('Write release').closest('[data-slot="flow-change-step"]')?.textContent,
    ).toContain('Updated: instructions');
    expect(screen.getByText('Could not remove this connection')).toBeTruthy();
    expect(screen.queryByText('Change audit')).toBeNull();
  });

  it('never auto-expands an applying mutation', () => {
    render(
      <FlowChangeArtifact
        presentation={{
          ...PRESENTATION,
          phase: 'applying',
          changes: PRESENTATION.changes.map((change) => ({ ...change, status: 'pending' })),
        }}
      />,
    );

    expect(screen.getByText('Updating Flow')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Show Flow steps for Release train' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByText('Requested flow')).toBeNull();
  });

  it.each([
    ['proposed', 'update', 'Flow change proposed', 'Launch → Write release'],
    ['applying', 'update', 'Updating Flow', 'Launch → Write release'],
    ['applied', 'create', 'Flow created', 'Launch → Write release'],
    ['applied', 'update', 'Flow updated', 'Launch → Write release'],
    ['unchanged', 'update', 'Flow is current', 'No new version saved'],
    ['failed', 'update', 'Flow not updated', 'The change was not saved'],
    ['denied', 'update', 'Flow not updated', 'Nothing changed'],
    ['stale', 'update', 'Flow changed elsewhere', 'Changed elsewhere. Refresh before retrying'],
  ] as const)('renders truthful %s receipt copy', (phase, mode, status, summary) => {
    render(<FlowChangeArtifact presentation={{ ...PRESENTATION, mode, phase }} />);

    expect(screen.getByText(status)).toBeTruthy();
    expect(screen.getByText(summary)).toBeTruthy();
  });

  it('uses the actual route as the create synopsis and renders every step in order', () => {
    const labels = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    render(
      <FlowChangeArtifact
        defaultExpanded
        presentation={{
          ...PRESENTATION,
          phase: 'applied',
          mode: 'create',
          graph: {
            nodes: labels.map((label, index) => ({
              id: `node-${index}`,
              label,
              blockType: index === 0 ? 'manual_trigger' : 'agent',
            })),
            edges: labels.slice(1).map((_, index) => ({
              id: `edge-${index}`,
              source: `node-${index}`,
              target: `node-${index + 1}`,
            })),
          },
          changes: labels.map((label, operationIndex) => ({
            operationIndex,
            action: 'add' as const,
            kind: 'node' as const,
            status: 'applied' as const,
            label,
            nodeId: `node-${operationIndex}`,
          })),
        }}
      />,
    );

    expect(screen.getByText('Alpha → Beta → Gamma → Delta')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How this Flow runs' })).toBeTruthy();
    expect(screen.getByText('Version 4 · 4 steps · 4 changes · 2 warnings')).toBeTruthy();
    for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('Next')).toBeNull();
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });

  it('refreshes the memoized outline when the semantic presentation revision changes', () => {
    const { rerender } = render(<FlowChangeArtifact defaultExpanded presentation={PRESENTATION} />);

    expect(screen.getByText('Write release')).toBeTruthy();

    rerender(
      <FlowChangeArtifact
        defaultExpanded
        presentation={{
          ...PRESENTATION,
          graph: {
            nodes: [
              { id: 'trigger', label: 'Launch', blockType: 'manual_trigger' },
              { id: 'agent', label: 'Publish release', blockType: 'agent' },
            ],
            edges: [{ id: 'edge', source: 'trigger', target: 'agent' }],
          },
          changes: [
            {
              operationIndex: 0,
              action: 'update',
              kind: 'node',
              status: 'applied',
              label: 'Publish release',
              nodeId: 'agent',
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('Publish release')).toBeTruthy();
    expect(screen.queryByText('Write release')).toBeNull();
  });

  it('keeps settings changes separate from the Flow route', () => {
    render(
      <FlowChangeArtifact
        defaultExpanded
        presentation={{
          ...PRESENTATION,
          changes: [
            {
              operationIndex: 0,
              action: 'update',
              kind: 'settings',
              status: 'applied',
              label: 'Briefing and pause behavior',
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Flow settings' })).toBeTruthy();
    expect(screen.getByText('Briefing and pause behavior')).toBeTruthy();
    expect(screen.getByText('Updated: flow settings')).toBeTruthy();
    expect(screen.queryByText('Launch')).toBeNull();
  });

  it('opens the Flow without exposing its identifier as presentation copy', () => {
    const onOpenFlow = vi.fn();
    const { container } = render(
      <FlowChangeArtifact presentation={PRESENTATION} onOpenFlow={onOpenFlow} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Flow' }));

    expect(onOpenFlow).toHaveBeenCalledWith('internal-flow-id');
    expect(container.innerHTML).not.toContain('internal-flow-id');
  });

  it('keeps the disclosure relationship and live outcome accessible', () => {
    const { container } = render(<FlowChangeArtifact presentation={PRESENTATION} />);
    const toggle = screen.getByRole('button', {
      name: 'Show Flow steps for Release train',
    });
    const detailsId = toggle.getAttribute('aria-controls');

    expect(detailsId).toBeTruthy();
    expect(document.getElementById(detailsId ?? '')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'Flow partly updated. Launch → Write release. 1 applied, 1 failed.',
    );

    fireEvent.click(toggle);

    expect(
      screen
        .getByRole('button', { name: 'Hide Flow steps for Release train' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(document.getElementById(detailsId ?? '')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByRole('region', { name: 'Flow structure' }).getAttribute('tabindex')).toBe(
      '0',
    );
  });

  it('keeps full receipt copy beside a keyboard-accessible recovery control', () => {
    const { container } = render(<FlowChangeArtifact presentation={PRESENTATION} />);
    const copy = container.querySelector('[data-slot="flow-change-copy"]');

    expect(copy?.hasAttribute('tabindex')).toBe(false);
    expect(copy?.textContent).toContain('Release train');
    expect(copy?.textContent).toContain('Launch → Write release. 1 applied, 1 failed');
    expect(screen.getByRole('button', { name: 'Show Flow steps for Release train' })).toBeTruthy();
  });

  it('reveals full receipt copy when the disclosure receives keyboard focus', () => {
    vi.useFakeTimers();
    render(<FlowChangeArtifact presentation={PRESENTATION} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Show Flow steps for Release train' }));
    act(() => vi.advanceTimersByTime(300));

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Flow partly updated · Release train');
    expect(tooltip.textContent).toContain('Launch → Write release. 1 applied, 1 failed');
  });

  it('uses Open Flow as the keyboard copy recovery when there is no outline', () => {
    vi.useFakeTimers();
    const onOpenFlow = vi.fn();
    const { container } = render(
      <FlowChangeArtifact
        onOpenFlow={onOpenFlow}
        presentation={{ ...PRESENTATION, changes: [], graph: undefined, phase: 'applied' }}
      />,
    );

    fireEvent.focus(screen.getByRole('button', { name: 'Open Flow' }));
    act(() => vi.advanceTimersByTime(300));

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('No reported changes');
    expect(tooltip.textContent).not.toContain('internal-flow-id');
    expect(document.body.innerHTML).not.toContain('internal-flow-id');

    fireEvent.click(screen.getByRole('button', { name: 'Open Flow' }));

    expect(onOpenFlow).toHaveBeenCalledWith('internal-flow-id');
    expect(container.innerHTML).not.toContain('internal-flow-id');
    expect(document.body.innerHTML).not.toContain('internal-flow-id');
  });

  it('uses truthful uncertainty copy for an interrupted mutation', () => {
    render(
      <FlowChangeArtifact
        onOpenFlow={vi.fn()}
        presentation={{ ...PRESENTATION, phase: 'interrupted' }}
      />,
    );

    expect(screen.getByText('Check this Flow')).toBeTruthy();
    expect(screen.getByText('Outcome unknown. Open the Flow to verify.')).toBeTruthy();
    expect(screen.queryByText(/nothing changed/i)).toBeNull();
  });

  it('does not offer an empty outline or a missing Open Flow action', () => {
    render(
      <FlowChangeArtifact
        presentation={{
          ...PRESENTATION,
          flowId: undefined,
          phase: 'unconfirmed',
          changes: [],
          graph: undefined,
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: /Flow steps/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Flow' })).toBeNull();
    expect(screen.getByText('Check this Flow')).toBeTruthy();
    expect(screen.getByText('Outcome unknown. Verify before retrying.')).toBeTruthy();
  });

  it('keeps the receipt compact and its responsive behavior in Tailwind utilities', () => {
    const { container } = render(<FlowChangeArtifact presentation={PRESENTATION} />);
    const artifact = screen.getByRole('region', { name: 'Release train' });
    const receipt = container.querySelector('[data-slot="flow-change-receipt"]');
    const status = screen.getByText('Flow partly updated');
    const title = screen.getByRole('heading', { name: 'Release train' });
    const summary = screen.getByText('Launch → Write release. 1 applied, 1 failed');
    const metadata = screen.getByText('Version 4 · 2 steps · 2 changes · 2 warnings');
    const toggle = screen.getByRole('button', { name: 'Show Flow steps for Release train' });

    expect(artifact.className).toContain('@container');
    expect(receipt?.className).toContain('py-2.5');
    expect(receipt?.className).not.toContain('min-h-');
    expect(status.parentElement).toBe(title.parentElement);
    expect(summary.parentElement).toBe(metadata.parentElement);
    expect(screen.getByText('Show flow').className).toContain('@max-[18rem]:sr-only');
    expect(toggle.querySelector('svg')?.getAttribute('class')).toContain(
      'motion-reduce:transition-none',
    );

    fireEvent.click(toggle);
    const details = screen.getByRole('region', { name: 'Flow structure' });
    expect(details.className).toContain('max-h-[min(340px,52vh)]');
    expect(details.className).toContain('overflow-y-auto');
  });

  it('tells an unread result apart from a failed and an unconfirmed write', () => {
    const copyFor = (phase: FlowChangePresentation['phase']) => {
      const { container } = render(
        <FlowChangeArtifact onOpenFlow={vi.fn()} presentation={{ ...PRESENTATION, phase }} />,
      );
      const copy = container.querySelector('[aria-live="polite"]')?.textContent ?? '';
      cleanup();
      return copy;
    };

    const unread = copyFor('unread');
    expect(unread).toContain('Flow change finished');
    expect(unread).toContain(
      'Result too large to show here. Open the Flow to see its current version.',
    );
    expect(unread).not.toMatch(/saved|unknown|not updated/i);
    expect(new Set([unread, copyFor('failed'), copyFor('unconfirmed')]).size).toBe(3);
  });

  it('warns against retrying an unread result that has no Flow to open', () => {
    render(
      <FlowChangeArtifact
        presentation={{ ...PRESENTATION, flowId: undefined, mode: 'create', phase: 'unread' }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open Flow' })).toBeNull();
    expect(
      screen.getByText('Result too large to show here. Check your Flows before retrying.'),
    ).toBeTruthy();
  });

  it('shows an unread result with no listed changes without an empty outline', () => {
    render(
      <FlowChangeArtifact
        onOpenFlow={vi.fn()}
        presentation={{ ...PRESENTATION, phase: 'unread', changes: [], graph: undefined }}
      />,
    );

    expect(screen.getByText('Flow change finished')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Flow steps/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Flow' })).toBeTruthy();
  });
});
