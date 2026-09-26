// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// getToolStatus' subagent override reaches the transport registry; stub it so the real module
// (Sentry/trpc/etc.) never loads. No case here is a subagent part, so the value is irrelevant.
vi.mock('../../../../lib/stores/active-transport-registry', async () => {
  const { atom } = await import('jotai');
  return {
    hasActiveTransport: () => false,
    runningSubagentToolIdsAtom: atom<ReadonlySet<string>>(new Set(['tool-running-task'])),
  };
});

import { AgentGenericToolCall, firstSubtitle, humanizeToolName } from './index';

describe('humanizeToolName', () => {
  it('reads machine tool names as prose', () => {
    expect(humanizeToolName('SubagentStarted')).toBe('Subagent started');
    expect(humanizeToolName('ImageGeneration')).toBe('Image generation');
    expect(humanizeToolName('codex_imageGeneration')).toBe('Codex image generation');
    expect(humanizeToolName('Sleep')).toBe('Sleep');
  });

  it('returns the original name when there is nothing to split', () => {
    expect(humanizeToolName('')).toBe('');
  });
});

describe('firstSubtitle', () => {
  it('picks the first stringy label the input carries, in preference order', () => {
    expect(firstSubtitle({ prompt: 'a prompt', path: '/x' })).toBe('a prompt');
    expect(firstSubtitle({ path: '/x' })).toBe('/x');
  });

  it('ignores non-string and empty values rather than rendering junk', () => {
    expect(firstSubtitle({ description: '', durationMs: 1000 })).toBeUndefined();
    expect(firstSubtitle(undefined)).toBeUndefined();
  });

  it('truncates a long label so it cannot blow out the card', () => {
    const subtitle = firstSubtitle({ prompt: 'x'.repeat(200) });
    expect(subtitle).toHaveLength(60);
    expect(subtitle?.endsWith('...')).toBe(true);
  });
});

describe('AgentGenericToolCall', () => {
  // The regression this component exists for: an unmapped tool used to render as an inert grey text
  // line, so a running job and a finished one looked identical. Asserted with a synthetic non-codex
  // tool name because the hole is provider-agnostic — Claude tools fall through it too.
  it('presents a running tool differently from a settled one', () => {
    // The whole regression: the old fallback was one static markup for every state, so a running job
    // and a finished one were indistinguishable. Asserted as markup inequality rather than against a
    // specific class, so a restyle of the pending treatment does not silently void the guarantee.
    const pending = render(
      <AgentGenericToolCall
        part={{ type: 'tool-SomeUnmappedTool', state: 'input-available' }}
        chatStatus="streaming"
      />,
    );
    const pendingMarkup = pending.container.innerHTML;
    expect(screen.getByText('Some unmapped tool')).toBeDefined();
    pending.unmount();

    const settled = render(
      <AgentGenericToolCall
        part={{ type: 'tool-SomeUnmappedTool', state: 'output-available', output: { ok: true } }}
        chatStatus="ready"
      />,
    );
    expect(screen.getByText('Some unmapped tool')).toBeDefined();
    expect(settled.container.innerHTML).not.toBe(pendingMarkup);
  });

  it('keeps a settled part pending while its background task still runs', () => {
    // A Workflow launch resolves its part immediately; main's task tracker says it is still running.
    const settledPart = { type: 'tool-Workflow', state: 'output-available', output: {} } as const;
    const idle = render(
      <AgentGenericToolCall
        part={{ ...settledPart, toolCallId: 'tool-done' }}
        chatStatus="ready"
      />,
    );
    const idleMarkup = idle.container.innerHTML;
    idle.unmount();
    const running = render(
      <AgentGenericToolCall
        part={{ ...settledPart, toolCallId: 'tool-running-task' }}
        chatStatus="ready"
      />,
    );
    expect(running.container.innerHTML).not.toBe(idleMarkup);
  });

  it('shows the failure reason when the tool errored', () => {
    // AgentToolCall does not render its isError prop, so an error that only sets state would be
    // invisible — the same written-but-never-read trap that hid failed codex subagent jobs.
    render(
      <AgentGenericToolCall
        part={{
          type: 'tool-ImageGeneration',
          state: 'output-error',
          errorText: 'content policy',
          input: { prompt: 'a cat' },
        }}
        chatStatus="ready"
      />,
    );
    expect(screen.getByText('content policy')).toBeDefined();
    expect(screen.queryByText('a cat')).toBeNull();
  });

  it('surfaces the tool input as the card subtitle', () => {
    render(
      <AgentGenericToolCall
        part={{
          type: 'tool-SubagentStarted',
          state: 'output-available',
          input: { path: '.codex/agents/design.md' },
        }}
        chatStatus="ready"
      />,
    );
    expect(screen.getByText('Subagent started')).toBeDefined();
    expect(screen.getByText('.codex/agents/design.md')).toBeDefined();
  });
});
