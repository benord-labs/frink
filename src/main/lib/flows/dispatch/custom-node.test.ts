import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedFlowGraph } from '../graph';

const { h } = vi.hoisted(() => ({ h: { executeShellStep: vi.fn() } }));
vi.mock('./shell-step', () => ({ executeShellStep: h.executeShellStep }));

import { dispatchCustomNode } from './custom-node';

const SHELL_OUTPUT = { status: 'completed' as const, outputs: {}, artifacts: [], durationMs: 0 };

// blockType is the manifest name for a user-defined node.
function customCtx(over: Record<string, unknown>) {
  return {
    flowRunId: 'fr',
    nodeRunId: 'nr',
    userId: 'u1',
    node: { id: 'cn', blockType: 'check-new-prs', config: {} },
    previousOutput: undefined,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: { nodes: [], edges: [] } as ParsedFlowGraph,
    signal: new AbortController().signal,
    ...over,
  };
}

const defaultProjectId = 'proj-default';

beforeEach(() => {
  vi.clearAllMocks();
  h.executeShellStep.mockResolvedValue(SHELL_OUTPUT);
});

describe('custom node project resolution', () => {
  it('runs on the flow default project and still renders templated config without leaking projectId into it', async () => {
    const res = await dispatchCustomNode(
      customCtx({
        node: { id: 'cn', blockType: 'check-new-prs', config: { repo: 'org/{{trigger.name}}' } },
        triggerContext: { name: 'frink' },
        parsedGraph: { nodes: [], edges: [], settings: { defaultProjectId: defaultProjectId } },
      }) as never,
    );

    expect(res.type).toBe('completed');
    const arg = h.executeShellStep.mock.calls[0][0];
    expect(arg.projectId).toBe(defaultProjectId);
    expect(arg.config.repo).toBe('org/frink');
    // projectId is passed as its own field, never duplicated into the manifest config.
    expect(arg.config.projectId).toBeUndefined();
  });

  it('renders a typed input as a whole placeholder, leaving coercion to the dispatch boundary', async () => {
    // Dispatch renders every top-level string; buildCustomNodeInputConfig converts the rendered
    // text back to the manifest-declared type just before the script is invoked.
    await dispatchCustomNode(
      customCtx({
        node: {
          id: 'cn',
          blockType: 'check-new-prs',
          config: { temperature: '{{previous.temperature}}', stormy: '{{previous.stormy}}' },
        },
        previousOutput: { outputs: { temperature: 12.5, stormy: false } },
        parsedGraph: { nodes: [], edges: [], settings: { defaultProjectId: defaultProjectId } },
      }) as never,
    );

    const arg = h.executeShellStep.mock.calls[0][0];
    expect(arg.config.temperature).toBe('12.5');
    expect(arg.config.stormy).toBe('false');
  });

  it('renders dynamic-option strings from previous, trigger, and loop contexts (sc-535)', async () => {
    await dispatchCustomNode(
      customCtx({
        node: {
          id: 'cn',
          blockType: 'check-new-prs',
          config: {
            previousChoice: '{{previous.choice}}',
            triggerChoice: '{{trigger.choice}}',
            loopChoice: '{{loop.currentItem}}',
          },
        },
        previousOutput: { outputs: { choice: 'previous-only-value' } },
        triggerContext: { choice: 'trigger-only-value' },
        loopContext: { currentItem: 'loop-only-value', currentIndex: 0, totalCount: 1 },
        parsedGraph: { nodes: [], edges: [], settings: { defaultProjectId: defaultProjectId } },
      }) as never,
    );

    expect(h.executeShellStep.mock.calls[0][0].config).toEqual({
      previousChoice: 'previous-only-value',
      triggerChoice: 'trigger-only-value',
      loopChoice: 'loop-only-value',
    });
  });

  it('renders {{flow.briefing}} empty — the variable is retired', async () => {
    // docs/decisions/flow-briefing-delivery-channel.md: the briefing is a system prompt, not a
    // template variable. dispatchCustomNode never supplies a `flow` root.
    await dispatchCustomNode(
      customCtx({
        node: { id: 'cn', blockType: 'check-new-prs', config: { note: '{{flow.briefing}}' } },
        parsedGraph: { nodes: [], edges: [], settings: { defaultProjectId: defaultProjectId } },
      }) as never,
    );

    // Renders empty, not literal: a retired root must not put its own placeholder text into a
    // custom node's input, where it would be coerced and used as a real value (sc-2706).
    expect(h.executeShellStep.mock.calls[0][0].config.note).toBe('');
  });

  it('fails with a message naming the flow default when no project is set anywhere', async () => {
    const res = await dispatchCustomNode(
      customCtx({ parsedGraph: { nodes: [], edges: [], settings: {} } }) as never,
    );
    expect(res.type).toBe('error');
    expect((res as { message: string }).message).toContain('flow default project');
  });
});
