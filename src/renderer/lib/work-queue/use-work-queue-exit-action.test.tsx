// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkQueueExitAction } from './use-work-queue-exit-action';

describe('useWorkQueueExitAction', () => {
  it('exits first while preserving arguments and return values', () => {
    const callOrder: string[] = [];
    const exitWorkQueue = vi.fn(() => callOrder.push('exit'));
    const action = vi.fn((value: string) => {
      callOrder.push(`action:${value}`);
      return value.length;
    });
    const { result } = renderHook(() => useWorkQueueExitAction(exitWorkQueue));

    expect(result.current(action)('chat-1')).toBe(6);
    expect(callOrder).toEqual(['exit', 'action:chat-1']);
    expect(action).toHaveBeenCalledWith('chat-1');
  });

  it('keeps wrappers stable and uses the latest exit callback', () => {
    const firstExit = vi.fn();
    const nextExit = vi.fn();
    const action = vi.fn();
    const { result, rerender } = renderHook(
      ({ exitWorkQueue }) => useWorkQueueExitAction(exitWorkQueue),
      { initialProps: { exitWorkQueue: firstExit } },
    );
    const wrapped = result.current(action);

    rerender({ exitWorkQueue: nextExit });
    expect(result.current(action)).toBe(wrapped);
    wrapped();
    expect(firstExit).not.toHaveBeenCalled();
    expect(nextExit).toHaveBeenCalledOnce();
  });
});
