// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceContextLock } from './use-workspace-context-lock';

let activeRunChatIds: string[] | undefined = [];

vi.mock('@/lib/trpc', () => ({
  trpc: {
    flows: {
      activeRunChatIds: { useQuery: () => ({ data: activeRunChatIds }) },
    },
  },
}));

beforeEach(() => {
  activeRunChatIds = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkspaceContextLock', () => {
  it('is unlocked for an idle chat', () => {
    const { result } = renderHook(() => useWorkspaceContextLock('chat-1', false));

    expect(result.current).toBe(false);
  });

  it('locks while any sub-chat of the chat is streaming', () => {
    const { result } = renderHook(() => useWorkspaceContextLock('chat-1', true));

    expect(result.current).toBe(true);
  });

  it('locks while the chat has a non-terminal flow run', () => {
    activeRunChatIds = ['chat-1'];
    const { result } = renderHook(() => useWorkspaceContextLock('chat-1', false));

    expect(result.current).toBe(true);
  });

  it('ignores another chat’s run', () => {
    activeRunChatIds = ['chat-2'];
    const { result } = renderHook(() => useWorkspaceContextLock('chat-1', false));

    expect(result.current).toBe(false);
  });

  it('stays unlocked with no chat id (the new-chat form)', () => {
    activeRunChatIds = ['chat-1'];
    const { result } = renderHook(() => useWorkspaceContextLock(undefined, false));

    expect(result.current).toBe(false);
  });

  it('holds the lock across the gap between two queued messages', () => {
    const { result, rerender } = renderHook(
      ({ streaming }) => useWorkspaceContextLock('chat-1', streaming),
      { initialProps: { streaming: true } },
    );
    expect(result.current).toBe(true);

    // The queue processor waits ~1s at status 'ready' before dispatching the next message.
    rerender({ streaming: false });
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(true);

    rerender({ streaming: true });
    expect(result.current).toBe(true);
  });

  it('releases once the chat has been idle past the hold', () => {
    const { result, rerender } = renderHook(
      ({ streaming }) => useWorkspaceContextLock('chat-1', streaming),
      { initialProps: { streaming: true } },
    );

    rerender({ streaming: false });
    act(() => void vi.advanceTimersByTime(2_000));

    expect(result.current).toBe(false);
  });
});
