// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import { COMPACTING_PENDING } from '../../../lib/agent-chat/planning/planning-status-message';
import { compactingSubChatsAtom } from '../atoms';
import { HtmlArtifactPaneProvider } from '../HtmlArtifactPane';
import type { Message, MessagePart } from '../stores/message-store';
import { buildNestedToolsMap } from './active-chat/utils';
import { AssistantMessageItem } from './assistant-message-item';

// Avoid pulling in code-editor/monaco (loads .css Vitest can't handle)
vi.mock('../ui/agent-edit-tool', () => ({
  AgentEditTool: () => null,
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {},
}));

vi.mock('../../../hooks/useFlowBaseSnapshot', () => ({
  useFlowBaseSnapshot: () => undefined,
}));

vi.mock('../../../components/ui/kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <span>{shortcutId}</span>,
}));

// Subagent card liveness: getToolStatus reads hasActiveTransport to decide whether a pending
// Task/Agent card is still running. Mock the dependency-free module so we can drive live vs dead.
const { hasActiveTransportMock } = vi.hoisted(() => ({
  hasActiveTransportMock: vi.fn(() => false),
}));
// Spread the original so the module's other exports (wakeHeldAtomFamily, which this component
// subscribes to) stay real — a bare object mock silently drops them.
vi.mock('../../../lib/stores/active-transport-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/stores/active-transport-registry')>()),
  hasActiveTransport: hasActiveTransportMock,
}));

const baseProps = {
  message: { id: 'msg-1', role: 'assistant' as const, parts: [], metadata: {} } as Message,
  isLastMessage: true,
  isLastAssistantMessage: true,
  isStreaming: false,
  status: 'ready',
  isMobile: false,
  subChatId: 'sub-1',
  chatId: 'chat-1',
  sandboxSetupStatus: 'ready' as const,
};
const EXPAND_STEPS_LABEL_REGEX = /Expand \d+ steps?/;
const APPROVE_AND_RUN_LABEL_REGEX = /Approve & Run/;
const UNKNOWN_TOOL_PART: MessagePart = {
  type: 'tool-UnknownLegacyTool',
  state: 'output-available',
};
/** An unregistered tool falls to the generic card, which reads its name as prose. */
const UNKNOWN_TOOL_LABEL = 'Unknown legacy tool';

function thinkingPart(text: string): MessagePart {
  return {
    type: 'tool-Thinking',
    state: 'output-available',
    input: { text },
  };
}

/** Streaming shape: requires toolCallId so memo compares `input` (see AgentThinkingTool / areToolPropsEqual). */
function thinkingPartStreaming(text: string, toolCallId = 'thinking-stream-test-1'): MessagePart {
  return {
    type: 'tool-Thinking',
    toolCallId,
    state: 'input-available',
    input: { text },
  };
}

function textPart(text: string): MessagePart {
  return {
    type: 'text',
    text,
  };
}

function buildAssistantMessage(id: string, parts: MessagePart[]): Message {
  return {
    id,
    role: 'assistant',
    parts,
    metadata: {},
  };
}

function toolPart(type: string, toolCallId: string, input?: Record<string, unknown>): MessagePart {
  return {
    type,
    toolCallId,
    state: 'output-available',
    ...(input ? { input } : {}),
  };
}

function awaitingApprovalPlanPart(planId: string): MessagePart {
  return {
    type: 'tool-frink-plan',
    toolCallId: `plan-${planId}`,
    state: 'output-available',
    input: {
      planId,
      summary: 'Plan ready for approval',
      status: 'awaiting_approval',
      planText: '## Plan\nImplement fix',
    },
  };
}

/** Same plan after its "Approve & Run" was clicked — markPlanApproved flips status to 'approved'. */
function approvedPlanPart(planId: string): MessagePart {
  const part = awaitingApprovalPlanPart(planId);
  return { ...part, input: { ...(part.input as Record<string, unknown>), status: 'approved' } };
}

// Task retry/carry-on controls are chat-level (TaskControls via RunStatusRow, rendered by
// ActiveChat above the composer), so this component no longer renders any task affordance.
describe('AssistantMessageItem rendering', () => {
  afterEach(() => {
    cleanup();
  });

  // An unregistered tool used to render as an inert grey text line carrying no state, so a running
  // job looked identical to a finished one. It now gets the same card treatment as a known tool.
  it('renders unknown tool parts as a stateful card, not an inert label', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-unknown-tool', [UNKNOWN_TOOL_PART])}
      />,
    );

    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();
  });

  it('renders a persisted HTML artifact as an inert inline action', () => {
    const artifact: MessagePart = {
      type: 'data-html-artifact',
      data: {
        version: 1,
        artifactId: 'digest',
        title: 'Customer message digest',
        bodyHtml: '<script>window.bad = true</script>',
      },
    };
    const { container } = render(
      <HtmlArtifactPaneProvider paneKey="chat-1:single" isPaneActive>
        <AssistantMessageItem
          {...baseProps}
          message={buildAssistantMessage('msg-artifact', [artifact])}
        />
      </HtmlArtifactPaneProvider>,
    );

    // Artifact HTML never reaches the transcript DOM, on either side of the flag.
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/Customer message digest/)).toBeInTheDocument();

    if (LAUNCH_FLAGS.flowHtmlArtifacts) {
      expect(screen.getByRole('button', { name: 'Run artifact' })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('button', { name: 'Run artifact' })).toBeNull();
    }
  });

  // Wiring, not classification: isSubagentTaskPart accepting the codex name is asserted in
  // agent-tool-registry.test.ts, but that only matters if renderPart reaches the subagent branch
  // BEFORE the generic-tool fallback. Swap the branch order and every unit test still passes while
  // codex subagent jobs quietly render as plain cards.
  it('routes a codex collab part to the subagent card, not the generic one', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        status="streaming"
        message={buildAssistantMessage('msg-codex-subagent', [
          {
            type: 'tool-CodexSubagent',
            state: 'input-available',
            toolCallId: 'c1',
            input: { description: 'Waiting on agents (2)', startedAt: Date.now() - 5_000 },
          },
        ])}
      />,
    );

    // AgentTaskTool's title, and its subtitle drawn from getSubagentLabel(input.description).
    expect(screen.getByText('Running Subagent')).toBeInTheDocument();
    expect(screen.getByText('Waiting on agents (2)')).toBeInTheDocument();
    // The generic card would have humanised the tool name instead.
    expect(screen.queryByText('Codex subagent')).toBeNull();
  });

  it('shows a failed codex collab job as failed rather than completed', () => {
    // End of the writer/reader contract: the mapper puts the failure in errorText, and the subagent
    // card is the reader. A regression on either side silently reports a failed job as a success.
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-codex-subagent-failed', [
          {
            type: 'tool-CodexSubagent',
            state: 'output-error',
            toolCallId: 'c1',
            errorText: 'Spawning agent failed',
            input: { description: 'Spawning agent' },
          },
        ])}
      />,
    );

    // Rendered twice by design: the visible title plus an aria-live announcement.
    expect(screen.getAllByText('Task failed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Completed Subagent')).toBeNull();
  });

  it('still names an unknown tool while it is in flight', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        status="streaming"
        message={buildAssistantMessage('msg-unknown-pending', [
          { type: 'tool-UnknownLegacyTool', state: 'input-available' },
        ])}
      />,
    );

    // Pending-vs-settled presentation is asserted in the AgentGenericToolCall unit test; here the
    // point is only that an in-flight unknown tool reaches the card at all.
    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();
  });

  it('keeps a lookalike Flow patch from another MCP server in the generic MCP card', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-untrusted-flow-tool', [
          {
            type: 'tool-mcp__evil__frink_flows_patch',
            toolCallId: 'evil-flow-1',
            state: 'output-available',
            input: { flowId: 'flow-1', operations: [] },
            output: { status: 'success', flowId: 'flow-1', name: 'Spoofed Flow' },
          },
        ])}
      />,
    );

    expect(screen.queryByRole('region', { name: 'Spoofed Flow' })).not.toBeInTheDocument();
    expect(screen.getByText(/Frink Flows Patch/i)).toBeInTheDocument();
  });

  it('routes the exact Cursor Flow patch name to the rich artifact', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-cursor-flow-tool', [
          {
            type: 'tool-frink_dynamic_chat-frink_flows_patch',
            toolCallId: 'cursor-flow-1',
            state: 'output-available',
            input: {
              flowId: 'flow-1',
              operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
            },
            result: {
              status: 'success',
              persistence: 'saved',
              flowId: 'flow-1',
              name: 'Cursor release flow',
              graph: { nodes: [], edges: [] },
              applied: [0],
            },
          },
          textPart('Done.'),
        ])}
      />,
    );

    expect(screen.getByRole('region', { name: 'Cursor release flow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeNull();
  });

  it('keeps a lookalike Flow patch from another MCP server in the generic MCP card', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-untrusted-flow-tool', [
          {
            type: 'tool-mcp__evil__frink_flows_patch',
            toolCallId: 'evil-flow-1',
            state: 'output-available',
            input: { flowId: 'flow-1', operations: [] },
            output: { status: 'success', flowId: 'flow-1', name: 'Spoofed Flow' },
          },
        ])}
      />,
    );

    expect(screen.queryByRole('region', { name: 'Spoofed Flow' })).not.toBeInTheDocument();
    expect(screen.getByText(/Frink Flows Patch/i)).toBeInTheDocument();
  });

  it('routes the exact Cursor Flow patch name to the rich artifact', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-cursor-flow-tool', [
          {
            type: 'tool-frink_dynamic_chat-frink_flows_patch',
            toolCallId: 'cursor-flow-1',
            state: 'result',
            input: {
              flowId: 'flow-1',
              operations: [{ op: 'update_settings', settings: { pauseOnFailure: true } }],
            },
            result: {
              status: 'success',
              persistence: 'saved',
              flowId: 'flow-1',
              name: 'Cursor release flow',
              graph: { nodes: [], edges: [] },
              applied: [0],
            },
          },
          textPart('Done.'),
        ])}
      />,
    );

    expect(screen.getByRole('region', { name: 'Cursor release flow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeNull();
  });

  it('keeps pre-final thinking and tool actions inside collapsed steps', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-collapsed-steps', [
          thinkingPart('Reasoning about next action'),
          UNKNOWN_TOOL_PART,
          textPart('Final answer'),
        ])}
      />,
    );

    const expandButton = screen.getByRole('button', { name: 'Expand 2 steps' });
    expect(expandButton).toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText('Thought')).toBeNull();
    expect(screen.queryByText(UNKNOWN_TOOL_LABEL)).toBeNull();

    fireEvent.click(expandButton);

    expect(screen.getByText('Thought')).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();
    expect(screen.getAllByText(UNKNOWN_TOOL_LABEL)).toHaveLength(1);
  });

  it('switches from live timeline to collapsed steps when streaming finishes', () => {
    vi.useFakeTimers();
    try {
      const message = buildAssistantMessage('msg-stream-boundary', [
        thinkingPart('Working through it'),
        UNKNOWN_TOOL_PART,
        textPart('Final answer'),
      ]);

      const { rerender } = render(
        <AssistantMessageItem {...baseProps} isStreaming message={message} />,
      );

      expect(screen.queryByRole('button', { name: 'Expand 2 steps' })).toBeNull();
      expect(screen.getByText('Thought')).toBeInTheDocument();
      expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();

      rerender(<AssistantMessageItem {...baseProps} isStreaming={false} message={message} />);
      vi.advanceTimersByTime(650);

      expect(
        screen.getByRole('button', {
          name: /Expand (2 steps|thinking content)/,
        }),
      ).toBeInTheDocument();
      expect(screen.getByText('Final answer')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts multiple thinking blocks and action tools in collapsed steps', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-multiple-thinking', [
          thinkingPart('First thought'),
          thinkingPart('Second thought'),
          UNKNOWN_TOOL_PART,
          textPart('Done.'),
        ])}
      />,
    );

    const expandButton = screen.getByRole('button', { name: 'Expand 3 steps' });
    fireEvent.click(expandButton);

    expect(screen.getAllByText('Thought')).toHaveLength(2);
    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();
  });

  it('keeps tools visible when there is no final text to collapse against', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-no-final-text', [
          thinkingPart('Interim reasoning'),
          UNKNOWN_TOOL_PART,
        ])}
      />,
    );

    expect(screen.queryByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeNull();
    expect(screen.getByText('Thought')).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();
  });

  it('filters structural parts from visible steps count', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-structural-filter', [
          { type: 'step-start' },
          thinkingPart('Reasoning'),
          textPart('   '),
          UNKNOWN_TOOL_PART,
          textPart('Final answer'),
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Expand 2 steps' })).toBeInTheDocument();
  });

  it('handles provider-style sparse and verbose pre-final timelines', () => {
    const { rerender } = render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-cursor-style', [
          UNKNOWN_TOOL_PART,
          textPart('Cursor final'),
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Expand 1 step' })).toBeInTheDocument();

    rerender(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-claude-style', [
          thinkingPart('Thought 1'),
          thinkingPart('Thought 2'),
          UNKNOWN_TOOL_PART,
          textPart('Claude final'),
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Expand 3 steps' })).toBeInTheDocument();
  });

  it('avoids duplicate pre-final tools across incremental rerenders', () => {
    const { rerender } = render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-incremental-1', [UNKNOWN_TOOL_PART])}
      />,
    );

    expect(screen.getByText(UNKNOWN_TOOL_LABEL)).toBeInTheDocument();

    rerender(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-incremental-2', [
          UNKNOWN_TOOL_PART,
          textPart('Final answer'),
        ])}
      />,
    );

    const expandButton = screen.getByRole('button', { name: 'Expand 1 step' });
    expect(screen.queryByText(UNKNOWN_TOOL_LABEL)).toBeNull();

    fireEvent.click(expandButton);
    expect(screen.getAllByText(UNKNOWN_TOOL_LABEL)).toHaveLength(1);
  });

  it('collapses while streaming when message is not the last one', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        isStreaming
        isLastMessage={false}
        message={buildAssistantMessage('msg-not-last-streaming', [
          thinkingPart('Done reasoning'),
          UNKNOWN_TOOL_PART,
          textPart('Final answer'),
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: 'Expand 2 steps' })).toBeInTheDocument();
    expect(screen.queryByText('Thought')).toBeNull();
    expect(screen.queryByText(UNKNOWN_TOOL_LABEL)).toBeNull();
  });

  it('renders exploring-group inside collapsed steps for consecutive exploring tools', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-exploring-collapsed', [
          toolPart('tool-Read', 'read-1'),
          toolPart('tool-Grep', 'grep-1'),
          toolPart('tool-Glob', 'glob-1'),
          textPart('Final answer'),
        ])}
      />,
    );

    const expandSteps = screen.getByRole('button', { name: 'Expand 3 steps' });
    fireEvent.click(expandSteps);

    expect(screen.getByText('Explored')).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
  });

  it('renders canonical frink-plan after collapsed steps bar so the plan is visible without expanding', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-frink-hoisted', [
          thinkingPart('The user wants a test plan.'),
          {
            type: 'tool-frink-plan',
            toolCallId: 'frink-hoist-1',
            state: 'output-available',
            input: {
              planId: 'frink-hoist-1',
              summary: 'Summary',
              status: 'awaiting_approval',
              planText: '# Hoisted plan',
            },
          },
          textPart('Final reply after plan.'),
        ])}
      />,
    );

    expect(screen.getByText('Plan ready for review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand 1 step' })).toBeInTheDocument();
  });

  it('keeps a generated image visible after the steps bar collapses', () => {
    // The reply text refers to the picture ("Here's a tabby cat"), so hiding the card behind
    // "N steps" would leave that sentence pointing at nothing.
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-image-hoisted', [
          thinkingPart('Generating an image.'),
          {
            type: 'tool-ImageGeneration',
            toolCallId: 'img-hoist-1',
            state: 'output-available',
            input: { prompt: 'a tabby cat' },
            output: { path: null },
          },
          textPart('Here is a tabby cat.'),
        ])}
      />,
    );

    expect(screen.getByText('Generated image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand 1 step' })).toBeInTheDocument();
  });

  it('dedupes duplicate plan markdown when frink-plan includes planText', () => {
    const rawPlan = '## Overview\nPlan overview body';
    const message = buildAssistantMessage('msg-plan-text-dedupe', [
      textPart(rawPlan),
      {
        type: 'tool-frink-plan',
        toolCallId: 'plan-dedupe-1',
        state: 'output-available',
        input: {
          planId: 'plan-dedupe-1',
          summary: 'Summary',
          status: 'awaiting_approval',
          planText: rawPlan,
        },
      },
    ]);

    render(<AssistantMessageItem {...baseProps} message={message} />);

    // The duplicate text part is removed, so the plan body renders once: inside the card.
    expect(screen.getAllByText(/Plan overview body/)).toHaveLength(1);
  });

  it('keeps Approve & Run on every unapproved plan card (re-plan: pick either A or B)', () => {
    // Two distinct plans awaiting approval in one message — the user may approve EITHER, so both
    // cards must keep their buttons until one is accepted (epoch close), not gate on recency.
    const planMessage = buildAssistantMessage('msg-plan-a-and-b', [
      awaitingApprovalPlanPart('plan-a'),
      textPart('On reflection, here is an alternative.'),
      awaitingApprovalPlanPart('plan-b'),
    ]);

    render(<AssistantMessageItem {...baseProps} message={planMessage} />);

    expect(screen.getAllByRole('button', { name: APPROVE_AND_RUN_LABEL_REGEX })).toHaveLength(2);
  });

  it('hides approval controls on a plan once it is approved', () => {
    const planId = 'approve-transition';
    const { rerender } = render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-plan-approve', [awaitingApprovalPlanPart(planId)])}
      />,
    );

    expect(screen.getByRole('button', { name: APPROVE_AND_RUN_LABEL_REGEX })).toBeInTheDocument();
    expect(screen.getByText('Awaiting your approval to proceed')).toBeInTheDocument();

    // Approval flips the plan part status to 'approved' (markPlanApproved) — the card goes read-only.
    rerender(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-plan-approve', [approvedPlanPart(planId)])}
      />,
    );

    expect(
      screen.queryByRole('button', { name: APPROVE_AND_RUN_LABEL_REGEX }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting your approval to proceed')).not.toBeInTheDocument();
  });

  it('converges both panes to non-interactive cards once the plan is approved', () => {
    const planId = 'multi-pane';
    const twoPanes = (part: MessagePart) => (
      <>
        <AssistantMessageItem
          {...baseProps}
          message={buildAssistantMessage('msg-plan-pane-1', [part])}
          subChatId="sub-shared"
        />
        <AssistantMessageItem
          {...baseProps}
          message={buildAssistantMessage('msg-plan-pane-2', [part])}
          subChatId="sub-shared"
        />
      </>
    );

    const { rerender } = render(twoPanes(awaitingApprovalPlanPart(planId)));
    expect(screen.getAllByRole('button', { name: APPROVE_AND_RUN_LABEL_REGEX })).toHaveLength(2);

    rerender(twoPanes(approvedPlanPart(planId)));
    expect(
      screen.queryByRole('button', { name: APPROVE_AND_RUN_LABEL_REGEX }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting your approval to proceed')).not.toBeInTheDocument();
  });
});

describe('AssistantMessageItem streaming thinking', () => {
  afterEach(() => {
    cleanup();
  });

  it('updates visible thinking body when text deltas arrive with stable state and toolCallId', () => {
    const messageId = 'msg-streaming-thinking-body';
    const { rerender } = render(
      <AssistantMessageItem
        {...baseProps}
        isStreaming
        status="streaming"
        message={buildAssistantMessage(messageId, [thinkingPartStreaming('First tokens')])}
      />,
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('First tokens')).toBeInTheDocument();

    rerender(
      <AssistantMessageItem
        {...baseProps}
        isStreaming
        status="streaming"
        message={buildAssistantMessage(messageId, [
          thinkingPartStreaming('First tokens and more streamed reasoning'),
        ])}
      />,
    );

    expect(screen.getByText('First tokens and more streamed reasoning')).toBeInTheDocument();
  });
});

// The empty-turn loading state is the flavor-phrase planning card alone — the old
// hardcoded "Thinking…" shimmer was removed (it doubled up with the planning card on
// turns that stream no thinking, e.g. codex models that emit no reasoning).
describe('AssistantMessageItem empty-turn placeholder', () => {
  afterEach(() => {
    cleanup();
  });

  it('never renders a bare "Thinking…" placeholder on an empty streaming turn', () => {
    // (A picked planning phrase may contain the word Thinking — e.g. "Thinking,
    // allegedly…" — but never the bare "Thinking..." literal.)
    const { container } = render(
      <AssistantMessageItem {...baseProps} isStreaming status="streaming" />,
    );
    expect(container.textContent).not.toContain('Thinking...');
  });

  // Compaction stalls the turn with nothing to show; the rotating phrase would read as the model
  // thinking about the prompt rather than the provider rewriting its context.
  it('names compaction on the empty-turn card while the sub-chat is compacting', () => {
    const store = getDefaultStore();
    store.set(compactingSubChatsAtom, new Set([baseProps.subChatId]));
    try {
      const { container } = render(
        <AssistantMessageItem {...baseProps} isStreaming status="streaming" />,
      );
      expect(container.textContent).toContain(COMPACTING_PENDING.title);
    } finally {
      store.set(compactingSubChatsAtom, new Set());
    }
  });
});

// Subagent nesting attribution — drives whether a subagent's tool calls render
// grouped under its card or spread flat in the main thread. Covers parallel
// subagents (Frink's multi-agent core), provider parity (Task + Agent), grandchild
// flattening, and the colon-id-but-not-a-subagent false-positive guard.
describe('buildNestedToolsMap', () => {
  const agent = (id: string, type = 'tool-Agent'): MessagePart => ({
    type,
    toolCallId: id,
    state: 'input-available',
  });
  const child = (id: string, type = 'tool-Bash'): MessagePart => ({
    type,
    toolCallId: id,
    state: 'output-available',
  });
  const ids = (parts: MessagePart[] | undefined) => parts?.map((p) => p.toolCallId);

  it('groups an Agent subagent’s children under it', () => {
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      agent('a'),
      child('a:1'),
      child('a:2'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:1', 'a:2']);
    expect(nestedToolIds.has('a:1')).toBe(true);
    expect(nestedToolIds.has('a:2')).toBe(true);
  });

  it('also groups under the legacy Task tool (cursor/executor path)', () => {
    const { nestedToolsMap } = buildNestedToolsMap([agent('t', 'tool-Task'), child('t:1')]);
    expect(ids(nestedToolsMap.get('t'))).toEqual(['t:1']);
  });

  it('keeps parallel subagents’ children in separate buckets', () => {
    const { nestedToolsMap } = buildNestedToolsMap([
      agent('a'),
      agent('b'),
      child('a:1'),
      child('b:1'),
      child('a:2'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:1', 'a:2']);
    expect(ids(nestedToolsMap.get('b'))).toEqual(['b:1']);
  });

  it('handles mixed Agent + Task parents in one message', () => {
    const { nestedToolsMap } = buildNestedToolsMap([
      agent('a', 'tool-Agent'),
      agent('t', 'tool-Task'),
      child('a:1'),
      child('t:1'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:1']);
    expect(ids(nestedToolsMap.get('t'))).toEqual(['t:1']);
  });

  it('attributes grandchildren (a:b:c) to the top-level parent a', () => {
    const { nestedToolsMap } = buildNestedToolsMap([agent('a'), agent('a:b'), child('a:b:c')]);
    // Sub-agent row + its grandchild both flatten under the top agent.
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:b', 'a:b:c']);
    expect(nestedToolsMap.get('a:b')).toBeUndefined();
  });

  it('does NOT nest a colon-id tool whose prefix is not a subagent parent', () => {
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      child('foo:bar', 'tool-Bash'),
      child('ghost:1'),
    ]);
    expect(nestedToolsMap.size).toBe(0);
    expect(nestedToolIds.size).toBe(0);
  });

  it('groups a subagent’s narration (thoughts, prose) alongside its tool calls', () => {
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      agent('a'),
      child('a:1'),
      child('a:think', 'tool-Thinking'),
      child('a:say', 'tool-SubagentText'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:1', 'a:think', 'a:say']);
    // Nested ids are what renderPart uses to keep these out of the main timeline.
    expect(nestedToolIds.has('a:think')).toBe(true);
    expect(nestedToolIds.has('a:say')).toBe(true);
  });

  it('nests a sub-subagent that names only its immediate parent (b:c under a)', () => {
    // A mid-turn sub-Task keys its children `b:c` while its own part is `a:b`. Without the
    // last-segment lookup the child escapes to the timeline — and prose escapes as a bare label.
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      agent('a'),
      agent('a:b'),
      child('b:c'),
      child('b:say', 'tool-SubagentText'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:b', 'b:c', 'b:say']);
    expect(nestedToolIds.has('b:say')).toBe(true);
  });

  it('walks a 4-level chain all the way to the card that renders it', () => {
    // Task a → sub-Task a:b → sub-sub-Task b:e → its child e:f. A single hop would stop at "b",
    // which no card reads, so the part would be hidden from the timeline AND rendered nowhere.
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      agent('a'),
      agent('a:b'),
      agent('b:e'),
      child('e:f'),
      child('e:say', 'tool-SubagentText'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:b', 'b:e', 'e:f', 'e:say']);
    expect(nestedToolIds.has('e:say')).toBe(true);
  });

  it('leaves an unresolvable nested part visible rather than hiding it into no card', () => {
    const { nestedToolsMap, nestedToolIds } = buildNestedToolsMap([
      agent('a'),
      child('ghost:1', 'tool-SubagentText'),
    ]);
    expect(nestedToolsMap.size).toBe(0);
    expect(nestedToolIds.has('ghost:1')).toBe(false);
  });

  it('keeps parallel subagents’ narration in their OWN cards', () => {
    // Frink's multi-agent core: two agents narrating at once must not pool into one card.
    const { nestedToolsMap } = buildNestedToolsMap([
      agent('a'),
      agent('b'),
      child('a:say', 'tool-SubagentText'),
      child('b:say', 'tool-SubagentText'),
      child('a:think', 'tool-Thinking'),
    ]);
    expect(ids(nestedToolsMap.get('a'))).toEqual(['a:say', 'a:think']);
    expect(ids(nestedToolsMap.get('b'))).toEqual(['b:say']);
  });

  it('ignores a subagent parent that has no toolCallId', () => {
    const { nestedToolsMap } = buildNestedToolsMap([
      { type: 'tool-Agent', state: 'input-available' },
      child('ghost:1'),
    ]);
    expect(nestedToolsMap.size).toBe(0);
  });
});

// End-to-end of the subagent-restart fix: a pending Task/Agent card animates "Running Subagent"
// only while its run is live (active transport). After a server/main-process restart the transport
// is gone, so it must read "Subagent interrupted" instead of spinning forever. status is 'ready'
// (the post-stream/post-restart state) in all three so the transport signal is the only difference.
describe('AssistantMessageItem subagent card liveness', () => {
  afterEach(() => {
    cleanup();
    hasActiveTransportMock.mockReset();
    hasActiveTransportMock.mockReturnValue(false);
  });

  const pendingSubagent: MessagePart = {
    type: 'tool-Agent',
    toolCallId: 'agent-1',
    state: 'input-available',
    input: { description: 'Research the codebase', startedAt: 1_000 },
  };

  it('animates "Running Subagent" while the run is live', () => {
    hasActiveTransportMock.mockReturnValue(true);
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-live', [pendingSubagent])}
      />,
    );
    expect(screen.getByText('Running Subagent')).toBeInTheDocument();
    expect(screen.queryByText('Subagent interrupted')).toBeNull();
  });

  it('reads "Subagent interrupted" once the run is dead (restart) — no infinite spinner', () => {
    hasActiveTransportMock.mockReturnValue(false);
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-dead', [pendingSubagent])}
      />,
    );
    expect(screen.getByText('Subagent interrupted')).toBeInTheDocument();
    expect(screen.queryByText('Running Subagent')).toBeNull();
  });

  it('shows "Completed Subagent" for a finished card regardless of transport', () => {
    hasActiveTransportMock.mockReturnValue(false);
    const done: MessagePart = {
      ...pendingSubagent,
      state: 'output-available',
      output: { result: 'success', output: 'done' },
    };
    render(
      <AssistantMessageItem {...baseProps} message={buildAssistantMessage('msg-done', [done])} />,
    );
    expect(screen.getByText('Completed Subagent')).toBeInTheDocument();
    expect(screen.queryByText('Subagent interrupted')).toBeNull();
  });

  // A frozen pending card in an OLDER turn must NOT re-animate when a new run later re-registers
  // the same subChatId (liveness is keyed per sub-chat, not per run). The active-turn gate keeps it
  // interrupted even though the transport reads live.
  it('does not re-animate an old (non-last) turn card even when the sub-chat is live again', () => {
    hasActiveTransportMock.mockReturnValue(true);
    render(
      <AssistantMessageItem
        {...baseProps}
        isLastMessage={false}
        isLastAssistantMessage={false}
        message={buildAssistantMessage('msg-old', [pendingSubagent])}
      />,
    );
    expect(screen.getByText('Subagent interrupted')).toBeInTheDocument();
    expect(screen.queryByText('Running Subagent')).toBeNull();
  });
});

/**
 * Collapsing steps behind a summary bar and labelling the trailing text "Response" is the
 * end-of-turn treatment. Wake bursts append to ONE assistant message, so a settled wait renders
 * as one collapsed message-so-far — and the collapse point must only ever advance, because the
 * next burst's first tool part flips the text-after-tools anchor false and would otherwise
 * re-expand the whole accumulated wait once per wake.
 */
describe('AssistantMessageItem — end-of-turn treatment', () => {
  // Tools then trailing text: the shape that normally collapses.
  const workThenText = [toolPart('tool-Bash', 'bash-1'), textPart('The ship is running.')];

  afterEach(() => {
    cleanup();
  });

  it('collapses a settled message: steps bar and Response render', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-done', workThenText)}
      />,
    );

    expect(screen.getByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeInTheDocument();
    expect(screen.getByText('Response')).toBeInTheDocument();
  });

  it('keeps the steps bar when a new burst appends a tool part after settled text', () => {
    const { rerender } = render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-latch', workThenText)}
      />,
    );
    expect(screen.getByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeInTheDocument();

    rerender(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-latch', [
          ...workThenText,
          toolPart('tool-Bash', 'bash-2'),
        ])}
      />,
    );
    expect(screen.getByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeInTheDocument();
  });

  it('renders a main-built thought as finished even while the chat streams', () => {
    // A thought completed by the main-process parts builder (the lane that drives observer windows
    // and every restored transcript) must read as finished, not as still-thinking with a blinking
    // caret, whenever a later burst streams into the same message.
    render(
      <AssistantMessageItem
        {...baseProps}
        isStreaming
        status="streaming"
        message={buildAssistantMessage('msg-result-think', [
          {
            type: 'tool-Thinking',
            toolCallId: 'th-1',
            state: 'output-available',
            input: { text: 'done' },
          },
        ])}
      />,
    );

    expect(screen.getByText('Thought')).toBeInTheDocument();
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  it('leaves earlier turns collapsed while a later turn streams', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        isLastMessage={false}
        message={buildAssistantMessage('msg-older-turn', workThenText)}
      />,
    );

    expect(screen.getByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeInTheDocument();
  });

  it('labels only the last assistant message, so a turn has one Response, not one per message', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        isLastMessage={false}
        isLastAssistantMessage={false}
        message={buildAssistantMessage('msg-earlier-1', workThenText)}
      />,
    );

    // The earlier message still collapses — it just doesn't claim to be the answer.
    expect(screen.getByRole('button', { name: EXPAND_STEPS_LABEL_REGEX })).toBeInTheDocument();
    expect(screen.queryByText('Response')).toBeNull();
  });

  // Same scoping as the Response label, for the same reason: a turn can span several assistant
  // messages, and one copy/format/usage row per message reads as duplicated controls.
  it('gives the turn one action row, on its last message only', () => {
    const { unmount } = render(
      <AssistantMessageItem
        {...baseProps}
        isLastMessage={false}
        isLastAssistantMessage={false}
        message={buildAssistantMessage('msg-earlier-2', workThenText)}
      />,
    );
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    unmount();

    render(
      <AssistantMessageItem
        {...baseProps}
        isLastMessage={false}
        message={buildAssistantMessage('msg-last', workThenText)}
      />,
    );
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  // The matching error is IPC-only and the window that would receive it is the one that went away,
  // so the persisted metadata is the ONLY thing left to say why the transcript stops. Without this
  // the turn renders as a frozen tool card and reads as a hang.
  it('states why a turn Frink tore down ended, from the persisted metadata alone', () => {
    const interrupted = {
      ...buildAssistantMessage('msg-reloaded', workThenText),
      metadata: { interruptedBy: 'renderer-reload' },
    } as Message;

    render(<AssistantMessageItem {...baseProps} message={interrupted} />);

    expect(screen.getByText(/the app window reloaded/i)).toBeInTheDocument();
  });

  it('says nothing about interruption for an ordinary completed turn', () => {
    render(
      <AssistantMessageItem
        {...baseProps}
        message={buildAssistantMessage('msg-normal', workThenText)}
      />,
    );

    expect(screen.queryByText(/app window reloaded/i)).toBeNull();
  });

  /**
   * A live tool part carries its answer on `output`; persistence mirrors the same value onto
   * `result`. Reading one field only made an answered question read "Waiting for response..." for
   * the rest of the turn and settle correctly just after a reload.
   */
  describe('an answered AskUserQuestion', () => {
    const QUESTION = {
      question: 'Which store?',
      header: 'Store',
      options: [{ label: 'Postgres', description: '' }],
      multiSelect: false,
    };
    const ANSWER = { 'Which store?': 'Postgres' };

    function answeredPart(answerField: 'output' | 'result'): MessagePart {
      return {
        type: 'tool-AskUserQuestion',
        toolCallId: 'toolu_answered',
        state: 'output-available',
        input: { questions: [QUESTION] },
        [answerField]: { questions: [QUESTION], answers: ANSWER },
      } as MessagePart;
    }

    it.each(['output', 'result'] as const)(
      'shows the answer while streaming, from `%s`',
      (answerField) => {
        render(
          <AssistantMessageItem
            {...baseProps}
            isStreaming
            status="streaming"
            message={buildAssistantMessage(`msg-answered-${answerField}`, [
              answeredPart(answerField),
            ])}
          />,
        );

        expect(screen.getByText('Postgres')).toBeInTheDocument();
        expect(screen.queryByText(/Waiting for response/i)).toBeNull();
      },
    );
  });
});
