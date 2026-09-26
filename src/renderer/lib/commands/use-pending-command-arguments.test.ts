// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SlashCommandOption } from './types';
import { usePendingCommandArguments } from './use-pending-command-arguments';

const withArgs: SlashCommandOption = {
  id: 'custom:plugin:user:slack:channel-digest',
  name: 'slack:channel-digest',
  command: '/slack:channel-digest',
  description: 'Digest a channel',
  category: 'repository',
  takesArguments: true,
  prompt: 'Summarise $ARGUMENTS.',
};
const noArgs: SlashCommandOption = {
  ...withArgs,
  name: 'slack:standup',
  takesArguments: false,
  prompt: 'Draft my standup.',
};

describe('usePendingCommandArguments', () => {
  it('holds a command that consumes arguments', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    let held = false;
    act(() => {
      held = result.current.holdForArguments(withArgs, result.current.beginPick(), true);
    });
    expect(held).toBe(true);
    expect(result.current.pending).toBe(withArgs);
  });

  it('lets a command that takes no arguments through untouched', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    let held = true;
    act(() => {
      held = result.current.holdForArguments(noArgs, result.current.beginPick(), true);
    });
    expect(held).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it('drops a body that arrives after the picker closed, instead of holding it', () => {
    const { result, rerender } = renderHook(({ open }) => usePendingCommandArguments(open), {
      initialProps: { open: true },
    });
    const pickedIn = result.current.beginPick();
    rerender({ open: false });
    act(() => {
      result.current.holdForArguments(withArgs, pickedIn, true);
    });
    expect(result.current.pending).toBeNull();
  });

  it('drops a body that arrives after the picker closed AND reopened', () => {
    const { result, rerender } = renderHook(({ open }) => usePendingCommandArguments(open), {
      initialProps: { open: true },
    });
    const pickedIn = result.current.beginPick();
    rerender({ open: false });
    rerender({ open: true });
    act(() => {
      result.current.holdForArguments(withArgs, pickedIn, true);
    });
    expect(result.current.pending).toBeNull();
  });

  it('clears a pending command when the picker closes', () => {
    const { result, rerender } = renderHook(({ open }) => usePendingCommandArguments(open), {
      initialProps: { open: true },
    });
    act(() => {
      result.current.holdForArguments(withArgs, result.current.beginPick(), true);
    });
    expect(result.current.pending).toBe(withArgs);
    rerender({ open: false });
    expect(result.current.pending).toBeNull();
  });

  it('clears on resolve', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    act(() => {
      result.current.holdForArguments(withArgs, result.current.beginPick(), true);
    });
    act(() => {
      result.current.resolve();
    });
    expect(result.current.pending).toBeNull();
  });

  it('decides from the fetched body, not a list flag that drifted while cached', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    // Scanned as argument-free, but the body fetched at pick time does consume $ARGUMENTS.
    const drifted = { ...noArgs, takesArguments: false, prompt: 'Summarise $ARGUMENTS.' };
    act(() => {
      result.current.holdForArguments(drifted, result.current.beginPick(), true);
    });
    expect(result.current.pending).toBe(drifted);
  });

  it('lets the latest pick win when two bodies are in flight at once', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    const first = result.current.beginPick();
    const second = result.current.beginPick();
    const other = { ...withArgs, name: 'slack:summarize-channel' };
    act(() => {
      result.current.holdForArguments(other, second, true);
    });
    act(() => {
      // The earlier fetch resolves late; it must not clobber the popover already open.
      result.current.holdForArguments(withArgs, first, true);
    });
    expect(result.current.pending).toBe(other);
  });

  it('leaves the raw template alone where arguments are not collected', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    let held = true;
    act(() => {
      held = result.current.holdForArguments(withArgs, result.current.beginPick(), false);
    });
    expect(held).toBe(false);
    expect(result.current.pending).toBeNull();
  });

  it('drops a superseded pick even when it takes no arguments, instead of inserting it late', () => {
    const { result } = renderHook(() => usePendingCommandArguments(true));
    const stale = result.current.beginPick();
    result.current.beginPick();
    let held = false;
    act(() => {
      held = result.current.holdForArguments(noArgs, stale, true);
    });
    expect(held).toBe(true);
    expect(result.current.pending).toBeNull();
  });
});
