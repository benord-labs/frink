// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScrollToBottomButton } from './ScrollToBottomButton';

/** The button is a pure function of its props — no container, no observers, no timers. */
function renderFab(hasLeftBottom: boolean, onScrollToBottom = vi.fn()) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ScrollToBottomButton hasLeftBottom={hasLeftBottom} onScrollToBottom={onScrollToBottom} />
    </TooltipProvider>,
  );
}

const findButton = () => screen.queryByRole('button', { name: 'Scroll to bottom' });

afterEach(cleanup);

describe('ScrollToBottomButton', () => {
  it('is hidden while the viewport is still following the bottom', () => {
    renderFab(false);
    expect(findButton()).toBeNull();
  });

  it('is shown once the user has left the bottom, and scrolls back on click', () => {
    const onScrollToBottom = vi.fn();
    renderFab(true, onScrollToBottom);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
  });

  // It is a direct child of the dock's pointer-events-none stack, off that stack's top edge.
  it('sits above its container and takes its own pointer events', () => {
    renderFab(true);
    expect(findButton()).toHaveClass('bottom-full', 'pointer-events-auto');
  });

  // Pins the library behaviour behind `hasLeftBottom={!isAtBottom}`: a button also driven by
  // escapedFromLock would stay up after its own click. stopScroll is the state an upward scroll sets.
  it("is driven by isAtBottom alone: the hook's scrollToBottom leaves escapedFromLock set", async () => {
    const { result } = renderHook(() => useStickToBottom());
    act(() => result.current.stopScroll());
    expect(result.current.isAtBottom).toBe(false);

    await act(async () => {
      await result.current.scrollToBottom({ animation: 'instant' });
    });

    expect(result.current.isAtBottom).toBe(true);
    expect(result.current.escapedFromLock).toBe(true);
  });
});
