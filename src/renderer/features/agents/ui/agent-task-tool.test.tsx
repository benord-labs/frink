// @vitest-environment happy-dom
/**
 * The async-launch label chain: an async Agent's tool part resolves at LAUNCH (output present,
 * chat back to 'ready'), so part state alone reads "Completed Subagent" while the task runs.
 * The card must follow main's task tracker via {@link runningSubagentToolIdsAtom} instead.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { runningSubagentToolIdsAtom } from '../../../lib/stores/active-transport-registry';
import type { MessagePart } from '../stores/message-store';
import { AgentMcpToolCall } from './agent-mcp-tool-call';
import { AgentTaskTool } from './agent-task-tool';
import type { McpToolInfo } from './agent-tool-registry';
import { AgentFlowTool } from './AgentFlowTool';

vi.mock('../../../hooks/useFlowBaseSnapshot', () => ({
  useFlowBaseSnapshot: () => undefined,
}));

const asyncLaunchedPart: MessagePart = {
  type: 'tool-Agent',
  toolCallId: 'tu-async-1',
  state: 'output-available',
  input: { prompt: 'research the codebase', subagent_type: 'Explore' },
  output: { output: 'Async agent launched successfully.' },
};

function renderCard(runningIds: ReadonlySet<string>) {
  const store = createStore();
  store.set(runningSubagentToolIdsAtom, runningIds);
  render(
    <Provider store={store}>
      <AgentTaskTool
        part={asyncLaunchedPart}
        nestedTools={[]}
        chatStatus="ready"
        subChatId="sub-1"
        isLastAssistantMessage
      />
    </Provider>,
  );
  return store;
}

describe('AgentTaskTool — async subagent liveness', () => {
  afterEach(() => {
    cleanup();
  });

  it('reads Completed Subagent when no task is tracked (the pre-channel behaviour)', () => {
    renderCard(new Set());
    expect(screen.getByText('Completed Subagent')).toBeInTheDocument();
  });

  it('reads Running Subagent while the tracker holds its toolCallId, and flips on retraction', () => {
    const store = renderCard(new Set(['tu-async-1']));
    expect(screen.getByText('Running Subagent')).toBeInTheDocument();

    act(() => {
      store.set(runningSubagentToolIdsAtom, new Set());
    });
    expect(screen.getByText('Completed Subagent')).toBeInTheDocument();
  });

  it("ignores another task's toolCallId", () => {
    renderCard(new Set(['tu-other']));
    expect(screen.getByText('Completed Subagent')).toBeInTheDocument();
  });
});

describe('AgentTaskTool — nested narration', () => {
  afterEach(() => {
    cleanup();
  });

  const bashPart: MessagePart = {
    type: 'tool-Bash',
    toolCallId: 'tu-async-1:child-bash',
    state: 'output-available',
    input: { command: 'ls' },
    output: { output: '' },
  };
  const thoughtPart: MessagePart = {
    type: 'tool-Thinking',
    toolCallId: 'tu-async-1:child-think',
    state: 'output-available',
    input: { text: 'weighing the options' },
    output: { completed: true },
  };
  const prosePart: MessagePart = {
    type: 'tool-SubagentText',
    toolCallId: 'tu-async-1:child-text',
    state: 'output-available',
    input: { text: 'I have enough to write the overview.' },
    output: { completed: true },
  };
  const flowPart: MessagePart = {
    type: 'tool-mcp__frink_dynamic_chat__frink_flows_patch',
    toolCallId: 'tu-async-1:child-flow',
    state: 'output-available',
    input: {
      flowId: 'flow-1',
      operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
    },
    result: {
      status: 'success',
      flowId: 'flow-1',
      name: 'Release train',
      graph: { nodes: [], edges: [] },
      applied: [0],
    },
  };

  function renderWithNested(nestedTools: MessagePart[], taskIsRunning = false) {
    const store = createStore();
    store.set(
      runningSubagentToolIdsAtom,
      taskIsRunning ? new Set([asyncLaunchedPart.toolCallId ?? '']) : new Set<string>(),
    );
    const tree = (tools: MessagePart[]) => (
      <Provider store={store}>
        <TooltipProvider>
          <AgentTaskTool
            part={asyncLaunchedPart}
            nestedTools={tools}
            chatStatus="ready"
            subChatId="sub-1"
            isLastAssistantMessage
          />
        </TooltipProvider>
      </Provider>
    );
    const view = render(tree(nestedTools));
    return {
      ...view,
      rerenderNested: (tools: MessagePart[]) => view.rerender(tree(tools)),
    };
  }

  it('shows a subagent thought and its prose once the card is expanded', async () => {
    renderWithNested([bashPart, thoughtPart, prosePart]);
    await userEvent.click(screen.getByText('Completed Subagent'));

    expect(screen.getByText('I have enough to write the overview.')).toBeInTheDocument();
    expect(screen.getByText('Thought')).toBeInTheDocument();
  });

  it('keeps the collapsed one-liner on real work, not on the trailing narration', () => {
    // Narration arrives LAST, so an unfiltered pick would surface it instead of the command.
    renderWithNested([bashPart, thoughtPart, prosePart]);
    expect(screen.getByText(/Ran command/)).toBeInTheDocument();
  });

  it('renders a nested Flow patch with the same rich artifact as a root patch', async () => {
    renderWithNested([flowPart]);
    await userEvent.click(screen.getByText('Completed Subagent'));

    expect(screen.getByRole('region', { name: 'Release train' })).toBeInTheDocument();
    expect(screen.getByText('Flow updated')).toBeInTheDocument();
    expect(screen.queryByText('Patched Flow')).not.toBeInTheDocument();
  });

  it('tints the cards nested in the glass Task card, which stay glass at top level', async () => {
    const mcpPart: MessagePart = {
      type: 'tool-mcp__codebase__search_code',
      toolCallId: 'tu-async-1:child-mcp',
      state: 'output-available',
      input: { query: 'glass' },
      output: { results: [] },
    };
    const mcpInfo: McpToolInfo = {
      serverName: 'codebase',
      toolName: 'search_code',
      displayName: 'Search Code',
      category: 'search',
    };
    const { container } = renderWithNested([flowPart, mcpPart]);
    await userEvent.click(screen.getByText('Completed Subagent'));

    expect(container.querySelectorAll('.glass-card')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Release train' })).toHaveClass('bg-muted/30');
    expect(screen.getByText('Search Code').closest('.bg-muted\\/30')).not.toBeNull();
    cleanup();

    render(
      <TooltipProvider>
        <AgentFlowTool part={flowPart} chatStatus="ready" />
        <AgentMcpToolCall part={mcpPart} mcpInfo={mcpInfo} chatStatus="ready" />
      </TooltipProvider>,
    );
    expect(screen.getByRole('region', { name: 'Release train' })).toHaveClass('glass-card');
    expect(screen.getByText('Search Code').closest('.glass-card')).not.toBeNull();
  });

  it('summarizes a collapsed nested Flow patch without exposing its opaque id', () => {
    renderWithNested([flowPart]);

    expect(screen.getByText('Patched Flow: 1 change')).toBeInTheDocument();
    expect(screen.queryByText(/flow-1/)).not.toBeInTheDocument();
  });

  it('keeps an in-flight nested Flow patch applying while the async subagent is live', async () => {
    const pendingFlowPart: MessagePart = {
      type: 'tool-mcp__frink_dynamic_chat__frink_flows_patch',
      toolCallId: 'tu-async-1:child-flow-pending',
      state: 'input-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
    };

    renderWithNested([pendingFlowPart], true);
    await userEvent.click(screen.getByText('Running Subagent'));

    expect(screen.getAllByText('Updating Flow').length).toBeGreaterThan(0);
    expect(screen.queryByText('Unconfirmed')).not.toBeInTheDocument();
  });

  it('recomputes a nested Flow artifact when its MessagePart mutates in place', async () => {
    const pendingFlowPart: MessagePart = {
      type: 'tool-mcp__frink_dynamic_chat__frink_flows_patch',
      toolCallId: 'tu-async-1:child-flow-mutated',
      state: 'input-available',
      input: {
        flowId: 'flow-1',
        operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
      },
    };
    const nestedTools = [pendingFlowPart];
    const view = renderWithNested(nestedTools, true);
    await userEvent.click(screen.getByText('Running Subagent'));
    expect(screen.getAllByText('Updating Flow').length).toBeGreaterThan(0);

    pendingFlowPart.state = 'output-available';
    pendingFlowPart.result = {
      status: 'success',
      persistence: 'saved',
      flowId: 'flow-1',
      name: 'Release train',
      graph: { nodes: [], edges: [] },
      applied: [0],
    };
    view.rerenderNested(nestedTools);

    expect(screen.getAllByText('Flow updated').length).toBeGreaterThan(0);
    expect(screen.queryByText('Updating Flow')).not.toBeInTheDocument();
  });
});
