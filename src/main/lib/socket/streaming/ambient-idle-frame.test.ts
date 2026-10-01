import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { isAmbientIdleFrame, isTurnBoundary } from './ambient-idle-frame';

const frame = (type: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type, ...extra }) as unknown as SDKMessage;

describe('isAmbientIdleFrame', () => {
  it('matches the between-turn system frames that never reach a result', () => {
    expect(isAmbientIdleFrame(frame('system', { subtype: 'task_progress' }))).toBe(true);
    expect(isAmbientIdleFrame(frame('system', { subtype: 'session_state_changed' }))).toBe(true);
  });

  it('leaves real turn frames alone', () => {
    expect(isAmbientIdleFrame(frame('system', { subtype: 'init' }))).toBe(false);
    expect(isAmbientIdleFrame(frame('assistant'))).toBe(false);
  });

  // A user stop of a shell or workflow emits exactly these two frames and no turn; a burst opened
  // on either would wait forever for a result.
  it('treats a task-set change and a stopped task as ambient', () => {
    expect(isAmbientIdleFrame(frame('system', { subtype: 'background_tasks_changed' }))).toBe(true);
    const stopped = { subtype: 'task_notification', status: 'stopped' };
    expect(isAmbientIdleFrame(frame('system', stopped))).toBe(true);
  });

  it('still wakes on a task that finished by itself', () => {
    for (const status of ['completed', 'failed']) {
      const notification = { subtype: 'task_notification', status };
      expect(isAmbientIdleFrame(frame('system', notification))).toBe(false);
    }
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
