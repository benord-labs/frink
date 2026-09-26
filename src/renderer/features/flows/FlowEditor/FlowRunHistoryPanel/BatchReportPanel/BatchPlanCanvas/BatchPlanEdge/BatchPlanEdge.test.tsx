// @vitest-environment happy-dom
/**
 * BatchPlanEdge — inline confirm delete pattern tests.
 */

import type { ComponentProps, MouseEventHandler, ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Position } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock RF components
vi.mock('@xyflow/react', () => ({
  Position: {
    Top: 'top',
    Bottom: 'bottom',
    Left: 'left',
    Right: 'right',
  },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getBezierPath: () => ['M 0 0', 50, 50],
}));

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    disabled,
  }: {
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
    'aria-label'?: string;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel} disabled={disabled}>
      {children}
    </button>
  ),
}));

const { BatchPlanEdge } = await import('.');

type BatchPlanEdgeProps = ComponentProps<typeof BatchPlanEdge>;

function renderEdge(overrides: Partial<BatchPlanEdgeProps> = {}) {
  const defaultProps = {
    id: 'e-1',
    source: 'stage-a',
    target: 'stage-b',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    selected: false,
    data: { editable: true, onDelete: vi.fn() },
    ...overrides,
  } satisfies Partial<BatchPlanEdgeProps>;
  return render(<BatchPlanEdge {...(defaultProps as BatchPlanEdgeProps)} />);
}

afterEach(() => cleanup());

describe('BatchPlanEdge — inline confirm delete', () => {
  it('does not show controls on initial render (not hovered)', () => {
    renderEdge();
    expect(screen.queryByLabelText('Remove this dependency')).not.toBeInTheDocument();
  });

  it('shows Remove button on hover', () => {
    const { container } = renderEdge();
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByLabelText('Remove this dependency')).toBeInTheDocument();
  });

  it('shows confirm dialog after clicking Remove', () => {
    const { container } = renderEdge();
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByLabelText('Remove this dependency'));
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm remove dependency')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel remove dependency')).toBeInTheDocument();
  });

  it('calls onDelete when Confirm is clicked', () => {
    const onDelete = vi.fn();
    const { container } = renderEdge({ data: { editable: true, onDelete } });
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByLabelText('Remove this dependency'));
    fireEvent.click(screen.getByLabelText('Confirm remove dependency'));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('does NOT call onDelete when Cancel is clicked', () => {
    const onDelete = vi.fn();
    const { container } = renderEdge({ data: { editable: true, onDelete } });
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByLabelText('Remove this dependency'));
    fireEvent.click(screen.getByLabelText('Cancel remove dependency'));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('hides controls when editable is false', () => {
    const { container } = renderEdge({ data: { editable: false, onDelete: vi.fn() } });
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.queryByLabelText('Remove this dependency')).not.toBeInTheDocument();
  });

  it('clears pendingDelete when deselected', () => {
    const { container, rerender } = renderEdge({ selected: true });
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByLabelText('Remove this dependency'));
    expect(screen.getByText('Remove?')).toBeInTheDocument();
    // Deselect
    rerender(
      <BatchPlanEdge
        id="e-1"
        source="stage-a"
        target="stage-b"
        sourceX={0}
        sourceY={0}
        targetX={100}
        targetY={100}
        sourcePosition={Position.Bottom}
        targetPosition={Position.Top}
        selected={false}
        data={{ editable: true, onDelete: vi.fn() }}
      />,
    );
    expect(screen.queryByText('Remove?')).not.toBeInTheDocument();
  });
});
