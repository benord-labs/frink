// @vitest-environment happy-dom
/**
 * A plugin step's card must read as its provider, never as Frink's plumbing:
 * the eyebrow states the plugin ("ClickUp"), not the internal `clickup_create_task`
 * node name, and the chip wears the provider's mark instead of the generic
 * custom-node glyph.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  Handle: ({ id, type }: { id?: string; type: string }) => (
    <span data-handle-id={id ?? ''} data-handle-type={type} />
  ),
  NodeToolbar: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  NodeResizer: ({ minWidth, minHeight }: { minWidth: number; minHeight: number }) => (
    <span data-resize="" data-min-width={minWidth} data-min-height={minHeight} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

import { FlowStepNodeView } from './index';

function renderCard(
  blockType: string,
  label?: string,
  extra?: Partial<React.ComponentProps<typeof FlowStepNodeView>>,
) {
  return render(
    <FlowStepNodeView
      node={{ id: 'n1', blockType, ...(label ? { label } : {}), config: {} }}
      index={0}
      isTrigger={false}
      isCondition={false}
      isEnd={false}
      graphLength={2}
      isSelected={false}
      showAppendStubDefault={false}
      showAppendStubTrue={false}
      showAppendStubFalse={false}
      onSelect={vi.fn()}
      onDelete={vi.fn()}
      onRequestAddStep={vi.fn()}
      {...extra}
    />,
  );
}

afterEach(cleanup);

describe('FlowStepNodeView plugin steps', () => {
  it('states the provider in the eyebrow, never the internal node name', () => {
    renderCard('clickup_create_task', 'Create a ClickUp task');

    expect(screen.getByText('ClickUp')).toBeInTheDocument();
    expect(screen.queryByText('clickup_create_task')).toBeNull();
  });

  it('keeps the eyebrow after the step is renamed', () => {
    renderCard('clickup_create_task', 'Notify the team');

    expect(screen.getByText('Notify the team')).toBeInTheDocument();
    expect(screen.getByText('ClickUp')).toBeInTheDocument();
  });

  it('names an unlabelled plugin step from the catalog, for graphs the picker did not author', () => {
    renderCard('clickup_create_task');

    expect(screen.getByText('Create a ClickUp task')).toBeInTheDocument();
    expect(screen.queryByText('clickup_create_task')).toBeNull();
  });

  it('leaves a user-authored custom node on its generic chip and raw type label', () => {
    renderCard('my_node');

    expect(screen.getAllByText('my_node').length).toBeGreaterThan(0);
  });
});

describe('FlowStepNodeView Fan Out', () => {
  it('shows one ordinary body connection inside the loop container', () => {
    const { container } = renderCard('fan_out');

    expect(screen.getByText('For each item')).toBeInTheDocument();
    const sourceHandles = container.querySelectorAll('[data-handle-type="source"]');
    expect(sourceHandles).toHaveLength(1);
    expect(sourceHandles[0]).toHaveAttribute('data-handle-id', 'out');
  });

  const minSize = { width: 760, height: 456 };

  it('makes the whole container resizable, floored at the fit', () => {
    const { container } = renderCard('fan_out', undefined, { fanOutMinSize: minSize });

    const resizer = container.querySelector('[data-resize]');
    expect(resizer).toHaveAttribute('data-min-width', '760');
    expect(resizer).toHaveAttribute('data-min-height', '456');
  });

  it('hides resize controls when read-only', () => {
    const { container } = renderCard('fan_out', undefined, {
      readOnly: true,
      fanOutMinSize: minSize,
    });
    expect(container.querySelector('[data-resize]')).toBeNull();
  });

  it('never offers resize controls on an ordinary step', () => {
    const { container } = renderCard('agent', undefined, { isSelected: true });
    expect(container.querySelector('[data-resize]')).toBeNull();
  });
});
