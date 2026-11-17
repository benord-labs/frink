import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeOutput } from '../../../../shared/types/flow';
import { createCustomNodeDispatcher } from './custom-node';
import type { executeShellStep } from './shell-step';
import type { DispatchContext } from './types';

const SHELL_OUTPUT: NodeOutput = { status: 'completed', outputs: {}, artifacts: [], durationMs: 0 };

const shellStep = vi.fn<typeof executeShellStep>();
const dispatch = createCustomNodeDispatcher({ executeShellStep: shellStep });

const defaultProjectId = 'proj-default';
const settings = { defaultProjectId: defaultProjectId };

/** An upstream step's output carrying only `outputs`, as dispatch reads it. */
function upstream(outputs: NodeOutput['outputs']): NodeOutput {
  return { ...SHELL_OUTPUT, outputs };
}

// blockType is the manifest name for a user-defined node.
function customCtx(over: Partial<DispatchContext>): DispatchContext {
  return {
    flowRunId: 'fr',
    nodeRunId: 'nr',
    node: { id: 'cn', blockType: 'check-new-prs', config: {} },
    previousOutput: undefined,
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: { nodes: [], edges: [] },
    signal: new AbortController().signal,
    ...over,
  };
}

/** The rendered config the script would receive from the most recent dispatch. */
function dispatchedConfig(): Parameters<typeof executeShellStep>[0]['config'] {
  return shellStep.mock.calls[0]?.[0].config;
}

beforeEach(() => {
  shellStep.mockReset();
  shellStep.mockResolvedValue(SHELL_OUTPUT);
});

describe('custom node project resolution', () => {
  it('runs on the flow default project and still renders templated config without leaking projectId into it', async () => {
    const res = await dispatch(
      customCtx({
        node: { id: 'cn', blockType: 'check-new-prs', config: { repo: 'org/{{trigger.name}}' } },
        triggerContext: { name: 'frink' },
        parsedGraph: { nodes: [], edges: [], settings },
      }),
    );

    expect(res.type).toBe('completed');
    expect(shellStep.mock.calls[0]?.[0].projectId).toBe(defaultProjectId);
    expect(dispatchedConfig()?.repo).toBe('org/frink');
    // projectId is passed as its own field, never duplicated into the manifest config.
    expect(dispatchedConfig()?.projectId).toBeUndefined();
  });

  it('renders a typed input as a whole placeholder, leaving coercion to the dispatch boundary', async () => {
    // Dispatch renders every top-level string; buildCustomNodeInputConfig converts the rendered
    // text back to the manifest-declared type just before the script is invoked.
    await dispatch(
      customCtx({
        node: {
          id: 'cn',
          blockType: 'check-new-prs',
          config: { temperature: '{{previous.temperature}}', stormy: '{{previous.stormy}}' },
        },
        previousOutput: upstream({ temperature: 12.5, stormy: false }),
        parsedGraph: { nodes: [], edges: [], settings },
      }),
    );

    expect(dispatchedConfig()?.temperature).toBe('12.5');
    expect(dispatchedConfig()?.stormy).toBe('false');
  });

  it('renders dynamic-option strings from previous, trigger, and loop contexts (sc-535)', async () => {
    await dispatch(
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
        previousOutput: upstream({ choice: 'previous-only-value' }),
        triggerContext: { choice: 'trigger-only-value' },
        loopContext: { currentItem: 'loop-only-value', currentIndex: 0, totalCount: 1 },
        parsedGraph: { nodes: [], edges: [], settings },
      }),
    );

    expect(dispatchedConfig()).toEqual({
      previousChoice: 'previous-only-value',
      triggerChoice: 'trigger-only-value',
      loopChoice: 'loop-only-value',
    });
  });

  it('renders {{flow.briefing}} empty — the variable is retired', async () => {
    // docs/decisions/flow-briefing-delivery-channel.md: the briefing is a system prompt, not a
    // template variable. dispatchCustomNode never supplies a `flow` root.
    await dispatch(
      customCtx({
        node: { id: 'cn', blockType: 'check-new-prs', config: { note: '{{flow.briefing}}' } },
        parsedGraph: { nodes: [], edges: [], settings },
      }),
    );

    // Renders empty, not literal: a retired root must not put its own placeholder text into a
    // custom node's input, where it would be coerced and used as a real value (sc-2706).
    expect(dispatchedConfig()?.note).toBe('');
  });

  it('fails with a message naming the flow default when no project is set anywhere', async () => {
    const res = await dispatch(customCtx({ parsedGraph: { nodes: [], edges: [], settings: {} } }));
    expect(res).toEqual({
      type: 'error',
      message: expect.stringContaining('flow default project'),
    });
  });
});

describe('custom node authored config (sc-3251)', () => {
  it('hands the executor the authored values alongside the rendered ones, byte-identical', async () => {
    // The executor picks authored values for "template": false inputs under its read lease.
    const jinja = '{% for x in xs %}{{ loop.index }}{% endfor %}';
    const long = `${'x'.repeat(12_000)}{{trigger.name}}`;
    await dispatch(
      customCtx({
        node: {
          id: 'cn',
          blockType: 'check-new-prs',
          config: {
            query: '{"q":"{{field}}","owner":"{{trigger.name}}"}',
            greeting: 'Hi {{ name }}!',
            jinja,
            long,
            retries: 3,
            projectId: 'p-static',
          },
        },
        triggerContext: { name: 'frink' },
        parsedGraph: { nodes: [], edges: [], settings },
      }),
    );

    const step = shellStep.mock.calls[0]?.[0];
    expect(step?.authoredConfig).toEqual({
      query: '{"q":"{{field}}","owner":"{{trigger.name}}"}',
      greeting: 'Hi {{ name }}!',
      jinja,
      long,
      retries: 3,
    });
    // Rendering is unchanged: a non-flow root still renders empty in the rendered config.
    expect(step?.config?.query).toBe('{"q":"","owner":"frink"}');
    expect(step?.config?.retries).toBe(3);
  });
});
