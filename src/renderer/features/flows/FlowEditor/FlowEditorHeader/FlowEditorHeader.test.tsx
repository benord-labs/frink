// @vitest-environment happy-dom
/**
 * FlowEditorHeader: always-visible Editor|Runs tabs, per-tab Add step, save cluster,
 * and the canvas-overlay status cluster (historical caption + Clear).
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../FlowLastRunBadge', () => ({
  FlowLastRunBadge: () => <div data-testid="last-run-badge" />,
}));

vi.mock('../NodeHealthBadge', () => ({
  NodeHealthBadge: () => <div data-testid="node-health" />,
}));

vi.mock('../FlowRunButton', () => ({
  FlowRunButton: ({
    onPrimaryStart,
    hasUnsavedChanges,
  }: {
    onPrimaryStart: () => void;
    hasUnsavedChanges?: boolean;
  }) => (
    <button
      type="button"
      onClick={onPrimaryStart}
      data-unsaved={String(Boolean(hasUnsavedChanges))}
    >
      run-button
    </button>
  ),
}));

vi.mock('../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../../components/ui/kbd', () => ({
  Kbd: () => null,
}));

vi.mock('../../../../lib/utils/format-time', () => ({
  formatRelativeTime: () => '1m ago',
}));

const { FlowEditorHeader } = await import('./index');

type HeaderProps = Parameters<typeof FlowEditorHeader>[0];

function makeProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
  return {
    flowId: 'flow-1',
    graph: { nodes: [], edges: [] },
    onBack: vi.fn(),
    title: 'My flow',
    onTitleChange: vi.fn(),
    onTitleBlur: vi.fn(),
    versionLabel: 'v3',
    save: {
      draftRestored: false,
      hasChanges: false,
      label: null,
      pending: false,
      disabled: true,
      onSave: vi.fn(),
      onDiscardDraft: vi.fn(),
    },
    overlay: { state: undefined, runMeta: undefined, onClear: vi.fn() },
    editorTab: 'editor',
    onEditorTabChange: vi.fn(),
    settingsOpen: false,
    onToggleSettings: vi.fn(),
    onAddStep: vi.fn(),
    run: {
      state: null,
      isBatchDeferred: false,
      disabled: false,
      pending: false,
      onPrimaryStart: vi.fn(),
    },
    ...overrides,
  };
}

afterEach(cleanup);

describe('FlowEditorHeader', () => {
  it('always renders the Editor|Runs toggle and switches tabs', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<FlowEditorHeader {...props} />);

    expect(screen.getByRole('button', { name: 'Editor' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Runs' }));
    expect(props.onEditorTabChange).toHaveBeenCalledWith('runs');
  });

  it('forwards unsaved canvas edits to the Run button', () => {
    const base = makeProps();
    const { rerender } = render(<FlowEditorHeader {...base} />);
    expect(screen.getByRole('button', { name: 'run-button' })).toHaveAttribute(
      'data-unsaved',
      'false',
    );
    rerender(
      <FlowEditorHeader {...makeProps({ run: { ...base.run, hasUnsavedChanges: true } })} />,
    );
    expect(screen.getByRole('button', { name: 'run-button' })).toHaveAttribute(
      'data-unsaved',
      'true',
    );
  });

  it('offers Add step on the Editor tab only', () => {
    const { rerender } = render(<FlowEditorHeader {...makeProps()} />);
    expect(screen.getByRole('button', { name: /Add step/ })).toBeInTheDocument();

    rerender(<FlowEditorHeader {...makeProps({ editorTab: 'runs' })} />);
    expect(screen.queryByRole('button', { name: /Add step/ })).not.toBeInTheDocument();
  });

  it('save cluster: label + Discard draft for a restored draft, save fires when enabled', async () => {
    const user = userEvent.setup();
    const props = makeProps({
      save: {
        draftRestored: true,
        hasChanges: true,
        label: 'Draft · unsaved changes',
        pending: false,
        disabled: false,
        onSave: vi.fn(),
        onDiscardDraft: vi.fn(),
      },
    });
    render(<FlowEditorHeader {...props} />);

    expect(screen.getByText('Draft · unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(props.save.onDiscardDraft).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(props.save.onSave).toHaveBeenCalled();
  });

  it('historical overlay shows the viewing caption and Clear fires onClear', async () => {
    const user = userEvent.setup();
    const props = makeProps({
      overlay: {
        state: { flowRunId: 'run-12345678', isHistoricalInspection: true },
        runMeta: {
          status: 'completed',
          active_task_status: null,
          started_at: '2026-06-04T00:00:00.000Z',
          completed_at: '2026-06-04T00:00:05.000Z',
        },
        onClear: vi.fn(),
      },
    });
    render(<FlowEditorHeader {...props} />);

    expect(screen.getByText('Viewing run from 1m ago')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Clear/ }));
    expect(props.overlay.onClear).toHaveBeenCalled();
  });

  it('live overlay announces Live with its start time', () => {
    render(
      <FlowEditorHeader
        {...makeProps({
          overlay: {
            state: { flowRunId: 'run-1', isLive: true },
            runMeta: {
              status: 'running',
              active_task_status: null,
              started_at: '2026-06-04T00:00:00.000Z',
              completed_at: null,
            },
            onClear: vi.fn(),
          },
        })}
      />,
    );
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('· started 1m ago')).toBeInTheDocument();
  });
});
