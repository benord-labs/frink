// @vitest-environment happy-dom
/**
 * FlowPreview must thread `flowId` into each node's data. That value keys the canvas
 * execution overlay (`nodeExecAtomFamily`, keyed `${flowId}:${nodeId}`), and
 * FlowStepNodeView forces exec state to null when it is falsy — so a dropped or stale
 * flowId silently disables the overlay instead of failing loudly.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type React from 'react';
import { ThemeProvider, useTheme } from 'next-themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';

type CapturedNode = { type?: string; data?: { flowId?: string } };

let capturedNodes: CapturedNode[] = [];

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, colorMode }: { nodes: CapturedNode[]; colorMode: string }) => {
    capturedNodes = nodes;
    return <div data-testid="rf-canvas" data-color-mode={colorMode} />;
  },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Handle: () => null,
  NodeToolbar: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  getBezierPath: () => ['', 0, 0],
  getSmoothStepPath: () => ['', 0, 0],
  useReactFlow: () => ({ fitView: vi.fn() }),
  useNodesInitialized: () => false,
  useStore: () => 0,
}));

import { FlowPreview } from './index';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'n1', blockType: 'manual_trigger', label: 'Start' },
    { id: 'n2', blockType: 'agent', label: 'Do the thing' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

function stepNodes(): CapturedNode[] {
  return capturedNodes.filter((n) => n.type === 'flowStep');
}

afterEach(() => {
  cleanup();
  capturedNodes = [];
});

function ThemeToggle() {
  const { setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme('dark')}>
      Use dark theme
    </button>
  );
}

describe('FlowPreview', () => {
  it('follows the application theme and updates when it changes', () => {
    const { getByTestId, getByRole } = render(
      <ThemeProvider defaultTheme="light" enableSystem={false} storageKey="flow-preview-theme-test">
        <ThemeToggle />
        <FlowPreview graph={GRAPH} />
      </ThemeProvider>,
    );
    expect(getByTestId('rf-canvas')).toHaveAttribute('data-color-mode', 'light');
    fireEvent.click(getByRole('button', { name: 'Use dark theme' }));
    expect(getByTestId('rf-canvas')).toHaveAttribute('data-color-mode', 'dark');
  });

  it('threads flowId into every step node', () => {
    render(<FlowPreview graph={GRAPH} flowId="flow-1" />);

    expect(stepNodes()).toHaveLength(2);
    for (const node of stepNodes()) {
      expect(node.data?.flowId).toBe('flow-1');
    }
  });

  it('leaves flowId undefined when omitted, so static previews get no exec overlay', () => {
    render(<FlowPreview graph={GRAPH} />);

    expect(stepNodes()).toHaveLength(2);
    for (const node of stepNodes()) {
      expect(node.data?.flowId).toBeUndefined();
    }
  });

  it('defaults to a 420px canvas that a caller className can override', () => {
    const { container, unmount } = render(<FlowPreview graph={GRAPH} />);
    expect(container.firstChild).toHaveClass('h-[420px]');
    unmount();

    // tailwind-merge resolves the conflict in the caller's favour, so an embedder can
    // give the canvas the height its graph needs without forking the component.
    const { container: tall } = render(<FlowPreview graph={GRAPH} className="h-[1020px]" />);
    expect(tall.firstChild).toHaveClass('h-[1020px]');
    expect(tall.firstChild).not.toHaveClass('h-[420px]');
  });

  it('re-enriches nodes when flowId changes', () => {
    const { rerender } = render(<FlowPreview graph={GRAPH} flowId="flow-1" />);
    rerender(<FlowPreview graph={GRAPH} flowId="flow-2" />);

    for (const node of stepNodes()) {
      expect(node.data?.flowId).toBe('flow-2');
    }
  });
});
