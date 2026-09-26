// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWindowEvent } from './use-window-event';

afterEach(cleanup);

function fire(eventName: string, detail?: unknown): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(eventName, detail === undefined ? {} : { detail }));
  });
}

describe('useWindowEvent', () => {
  it('invokes the handler for each dispatch and stops after unmount', () => {
    const handler = vi.fn();
    const { unmount } = render(<Harness eventName="test:ping" onEvent={handler} />);

    fire('test:ping');
    fire('test:ping');
    expect(handler).toHaveBeenCalledTimes(2);

    unmount();
    fire('test:ping');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('passes the event through so CustomEvent detail is readable', () => {
    const handler = vi.fn();
    render(<Harness eventName="test:detail" onEvent={handler} />);

    fire('test:detail', { chatId: 'chat-1' });

    const received = handler.mock.calls[0]?.[0] as CustomEvent<{ chatId: string }>;
    expect(received.detail.chatId).toBe('chat-1');
  });

  // The handler lives in a ref precisely so callers can pass an inline arrow. If the
  // effect re-ran per render it would churn listeners on every parent state change.
  it('does not re-subscribe when the handler identity changes', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { rerender } = render(<Harness eventName="test:stable" onEvent={() => {}} />);
    const initialCount = addSpy.mock.calls.filter(([name]) => name === 'test:stable').length;

    rerender(<Harness eventName="test:stable" onEvent={() => {}} />);
    rerender(<Harness eventName="test:stable" onEvent={() => {}} />);

    const finalCount = addSpy.mock.calls.filter(([name]) => name === 'test:stable').length;
    expect(finalCount).toBe(initialCount);
    addSpy.mockRestore();
  });

  // Holding the handler in a ref must not cost freshness: a handler that closes over
  // state has to see the latest value, not the one captured on the first render.
  it('runs the latest handler, not the one captured on mount', () => {
    const seen: number[] = [];
    render(<CounterHarness onEvent={(count) => seen.push(count)} />);

    fire('test:counter');
    fire('test:increment');
    fire('test:counter');

    expect(seen).toEqual([0, 1]);
  });

  it('moves the subscription when the event name changes', () => {
    const handler = vi.fn();
    const { rerender } = render(<Harness eventName="test:first" onEvent={handler} />);

    rerender(<Harness eventName="test:second" onEvent={handler} />);

    fire('test:first');
    expect(handler).not.toHaveBeenCalled();

    fire('test:second');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function Harness({ eventName, onEvent }: { eventName: string; onEvent: (event: Event) => void }) {
  useWindowEvent(eventName, onEvent);
  return null;
}

/** Re-renders on `test:increment` so the counter handler closes over a changing value. */
function CounterHarness({ onEvent }: { onEvent: (count: number) => void }) {
  const [count, setCount] = useState(0);
  useWindowEvent('test:increment', () => setCount((c) => c + 1));
  useWindowEvent('test:counter', () => onEvent(count));
  return null;
}
