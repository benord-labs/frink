// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { promptCacheTimerEnabledAtom } from '../../../../lib/atoms';
import { formatCacheRemaining, PromptCacheTimer } from './index';

const NOW = 1_700_000_000_000;

function renderTimer(expiresAt: number | null, { enabled = true } = {}) {
  const store = createStore();
  store.set(promptCacheTimerEnabledAtom, enabled);
  return render(
    <Provider store={store}>
      <TooltipProvider>
        <PromptCacheTimer expiresAt={expiresAt} />
      </TooltipProvider>
    </Provider>,
  );
}

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('formatCacheRemaining', () => {
  it('rounds up to whole seconds so a warm cache never reads 0:00', () => {
    expect(formatCacheRemaining(3_600_000)).toBe('60:00');
    expect(formatCacheRemaining(65_000)).toBe('1:05');
    expect(formatCacheRemaining(1)).toBe('0:01');
  });
});

describe('PromptCacheTimer', () => {
  it('counts down each second', () => {
    renderTimer(NOW + 5 * 60_000);
    expect(screen.getByRole('img').textContent).toBe('5:00');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('img').textContent).toBe('4:59');
  });

  it('switches to the warning colour in the last minute', () => {
    renderTimer(NOW + 61_000);
    expect(screen.getByRole('img').className).not.toContain('text-warning');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('img').className).toContain('text-warning');
  });

  it('drops the countdown and explains the cost once expired', () => {
    renderTimer(NOW + 1000);
    act(() => vi.advanceTimersByTime(1000));
    const timer = screen.getByRole('img');
    expect(timer.textContent).toBe('');
    expect(timer.getAttribute('aria-label')).toContain('re-sends the full context uncached');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders nothing without an expiry or when turned off in settings', () => {
    const { container: noExpiry } = renderTimer(null);
    const { container: disabled } = renderTimer(NOW + 60_000, { enabled: false });
    expect(noExpiry.innerHTML).toBe('');
    expect(disabled.innerHTML).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
});
