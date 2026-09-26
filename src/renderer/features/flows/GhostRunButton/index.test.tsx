// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomNodeInputsByType } from '../../../../shared/lib/flows/custom-node-required-inputs';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { ghostRunActiveAtom, ghostRunHeaderStateAtom } from '../../../lib/flow-rehearsal';
import { appStore } from '../../../lib/jotai-store';
import { GhostRunButton } from './index';

const oneNode: FlowGraph = { nodes: [{ id: 't', blockType: 'manual_trigger' }], edges: [] };

function renderButton(graph: FlowGraph, customNodeInputs?: CustomNodeInputsByType) {
  return render(
    <ReactFlowProvider>
      <Provider store={appStore}>
        <GhostRunButton graph={graph} flowId="f1" customNodeInputs={customNodeInputs} />
      </Provider>
    </ReactFlowProvider>,
  );
}

describe('GhostRunButton', () => {
  afterEach(() => {
    cleanup();
    appStore.set(ghostRunActiveAtom, false);
  });

  it('toggles the rehearsal overlay on click (and back)', async () => {
    const user = userEvent.setup();
    renderButton(oneNode);
    await user.click(screen.getByLabelText('Rehearse flow'));
    expect(screen.getByLabelText('Stop rehearsal')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Stop rehearsal'));
    expect(screen.getByLabelText('Rehearse flow')).toBeInTheDocument();
  });

  it('re-runs the rehearsal when manifests arrive after it was started', async () => {
    // Manifests load asynchronously. A rehearsal started first must not stay stuck claiming the
    // flow is healthy once the required-input data it needed finally lands.
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cn', blockType: 'my-custom-node', config: {} },
      ],
      edges: [{ id: 'e', source: 't', target: 'cn' }],
    };
    const user = userEvent.setup();
    const { rerender } = renderButton(graph);
    await user.click(screen.getByLabelText('Rehearse flow'));
    expect(appStore.get(ghostRunHeaderStateAtom)?.findingCount ?? 0).toBe(0);

    rerender(
      <ReactFlowProvider>
        <Provider store={appStore}>
          <GhostRunButton
            graph={graph}
            flowId="f1"
            customNodeInputs={new Map([['my-custom-node', { repo: { required: true } }]])}
          />
        </Provider>
      </ReactFlowProvider>,
    );

    const findings = appStore.get(ghostRunHeaderStateAtom)?.findings ?? [];
    expect(findings.map((f) => f.rule)).toContain('custom_node.missing_required_input');
  });

  it('re-runs a debounced rehearsal after the graph is edited while active', () => {
    // Config fields replace the graph per keystroke; the overlay must follow edits without
    // rehearsing the whole flow per character.
    vi.useFakeTimers();
    try {
      const inputs: CustomNodeInputsByType = new Map([
        ['my-custom-node', { repo: { required: true } }],
      ]);
      const node = (config: Record<string, string>): FlowGraph => ({
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'cn', blockType: 'my-custom-node', config },
        ],
        edges: [{ id: 'e', source: 't', target: 'cn' }],
      });
      const { rerender } = renderButton(node({ repo: 'owner/x' }), inputs);
      act(() => appStore.set(ghostRunActiveAtom, true));
      expect(appStore.get(ghostRunHeaderStateAtom)?.findingCount ?? 0).toBe(0);

      rerender(
        <ReactFlowProvider>
          <Provider store={appStore}>
            <GhostRunButton graph={node({ repo: '' })} flowId="f1" customNodeInputs={inputs} />
          </Provider>
        </ReactFlowProvider>,
      );
      // Still the previous result until the edit settles.
      expect(appStore.get(ghostRunHeaderStateAtom)?.findingCount ?? 0).toBe(0);

      act(() => vi.advanceTimersByTime(300));
      const findings = appStore.get(ghostRunHeaderStateAtom)?.findings ?? [];
      expect(findings.map((f) => f.rule)).toContain('custom_node.missing_required_input');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is disabled when the graph has no nodes', () => {
    renderButton({ nodes: [], edges: [] });
    expect(screen.getByLabelText('Rehearse flow')).toBeDisabled();
  });
});
