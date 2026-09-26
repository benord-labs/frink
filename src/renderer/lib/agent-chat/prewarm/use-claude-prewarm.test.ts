// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import type { FocusEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREWARM_DWELL_MS,
  PREWARM_FOCUS_THROTTLE_MS,
  useClaudePrewarm,
} from './use-claude-prewarm';

const prewarm = vi.fn();
const render = (armed: boolean) =>
  renderHook(({ on }) => useClaudePrewarm(on, prewarm), { initialProps: { on: armed } });
const composer = document.createElement('div');
composer.setAttribute('data-chat-composer-root', '');
const editor = composer.appendChild(document.createElement('div'));
editor.setAttribute('data-chat-input', 'true');
const modelPicker = composer.appendChild(document.createElement('button'));
const focus = (target: Element) => ({ target }) as unknown as FocusEvent;

describe('useClaudePrewarm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prewarm.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('asks once the chat has stayed the open pane for the dwell', () => {
    render(true);

    vi.advanceTimersByTime(PREWARM_DWELL_MS - 1);
    expect(prewarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(PREWARM_DWELL_MS * 10);

    expect(prewarm).toHaveBeenCalledOnce();
  });

  it('never asks for a chat passed through, or one not armed (streaming, a task chat)', () => {
    const { rerender } = render(true);
    vi.advanceTimersByTime(PREWARM_DWELL_MS - 1);
    rerender({ on: false });
    vi.advanceTimersByTime(PREWARM_DWELL_MS * 10);
    render(false);
    vi.advanceTimersByTime(PREWARM_DWELL_MS * 10);

    expect(prewarm).not.toHaveBeenCalled();
  });

  it('asks again the dwell after a stream settles', () => {
    const { rerender } = render(true);
    vi.advanceTimersByTime(PREWARM_DWELL_MS);
    rerender({ on: false });
    rerender({ on: true });
    vi.advanceTimersByTime(PREWARM_DWELL_MS);

    expect(prewarm).toHaveBeenCalledTimes(2);
  });

  it('asks on editor focus after the dwell, at most every 30s, and on no other focus', () => {
    const { result } = render(true);
    result.current(focus(editor));
    expect(prewarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PREWARM_DWELL_MS);
    expect(prewarm).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(PREWARM_FOCUS_THROTTLE_MS - 1);
    result.current(focus(editor));
    expect(prewarm).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    // A composer control (model, mode) changes the settings the send will carry.
    result.current(focus(modelPicker));
    result.current(focus(document.createElement('button')));
    expect(prewarm).toHaveBeenCalledOnce();
    result.current(focus(editor));
    result.current(focus(editor));

    expect(prewarm).toHaveBeenCalledTimes(2);
  });
});
