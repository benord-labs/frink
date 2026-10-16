import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { admitTurnFrame, isMainTurnStart, isTurnBoundary } from './ambient-idle-frame';

const frame = (type: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type, ...extra }) as unknown as SDKMessage;

const agentCall = (id: string, parent?: string): SDKMessage =>
  frame('assistant', {
    message: { content: [{ type: 'tool_use', id, name: 'Agent' }] },
    parent_tool_use_id: parent,
  });

describe('isMainTurnStart', () => {
  it("matches the CLI's turn opener and the main agent's own frames", () => {
    expect(isMainTurnStart(frame('system', { subtype: 'init' }))).toBe(true);
    expect(isMainTurnStart(frame('assistant', { parent_tool_use_id: null }))).toBe(true);
    expect(isMainTurnStart(frame('user'))).toBe(true);
    expect(isMainTurnStart(frame('stream_event', { parent_tool_use_id: null }))).toBe(true);
    expect(isMainTurnStart(frame('result', { subtype: 'success' }))).toBe(true);
  });

  // A background subagent streams these while the main agent idles; none of them is a main turn.
  it("rejects a subagent's frames, task notifications and stream noise", () => {
    expect(isMainTurnStart(frame('assistant', { parent_tool_use_id: 'toolu_agent' }))).toBe(false);
    expect(isMainTurnStart(frame('user', { parent_tool_use_id: 'toolu_agent' }))).toBe(false);
    for (const status of ['completed', 'failed', 'stopped']) {
      expect(isMainTurnStart(frame('system', { subtype: 'task_notification', status }))).toBe(
        false,
      );
    }
    expect(isMainTurnStart(frame('system', { subtype: 'task_progress' }))).toBe(false);
    expect(isMainTurnStart(frame('rate_limit_event'))).toBe(false);
    expect(isMainTurnStart(frame('tool_progress'))).toBe(false);
  });
});

describe('admitTurnFrame', () => {
  it("admits the main agent's frames and the subagents it launched in this turn", () => {
    const own = new Set<string>();
    expect(admitTurnFrame(agentCall('toolu_mine'), own)).toBe(true);
    expect(admitTurnFrame(frame('user', { parent_tool_use_id: 'toolu_mine' }), own)).toBe(true);
    // A subagent's own subagent belongs to this turn too.
    const nested = agentCall('toolu_nested', 'toolu_mine');
    expect(admitTurnFrame(nested, own)).toBe(true);
    expect(admitTurnFrame(frame('user', { parent_tool_use_id: 'toolu_nested' }), own)).toBe(true);
  });

  // An earlier turn's background subagent, still streaming, would otherwise show its tool calls in
  // the user's new reply as if the main agent had made them.
  it('drops frames of a subagent launched before this turn', () => {
    const own = new Set<string>();
    const foreign = agentCall('toolu_inner', 'toolu_earlier');
    expect(admitTurnFrame(foreign, own)).toBe(false);
    expect(own.has('toolu_inner')).toBe(false);
  });
});

describe('isTurnBoundary', () => {
  // Frink's own pushes carry no origin at all, so an absent one is ours.
  it('treats a result with no origin as the end of our turn', () => {
    expect(isTurnBoundary(frame('result', { subtype: 'success' }))).toBe(true);
    expect(isTurnBoundary(frame('result', { origin: undefined }))).toBe(true);
    expect(isTurnBoundary(frame('result', { origin: { kind: 'human' } }))).toBe(true);
  });

  // The CLI stamps an origin on prompts it generated itself — a task notification it enqueued, or
  // the `Continue from where you left off.` continuation after an interrupt. Ending our turn on one
  // of those files the harness's turn as the reply and abandons the real one behind it.
  it('does not end our turn on a result the harness produced for its own turn', () => {
    expect(isTurnBoundary(frame('result', { origin: { kind: 'task-notification' } }))).toBe(false);
    expect(isTurnBoundary(frame('result', { origin: { kind: 'auto-continuation' } }))).toBe(false);
  });

  it('ignores non-result frames even when they carry an origin', () => {
    expect(isTurnBoundary(frame('assistant', { origin: { kind: 'task-notification' } }))).toBe(
      false,
    );
    expect(isTurnBoundary(frame('assistant'))).toBe(false);
  });
});
