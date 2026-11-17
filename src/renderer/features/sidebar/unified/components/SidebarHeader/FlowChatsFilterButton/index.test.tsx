// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { hideFlowChatsAtom } from '@/lib/atoms';
import { FlowChatsFilterButton } from './index';

function renderButton(store: ReturnType<typeof createStore>) {
  render(
    <Provider store={store}>
      <TooltipProvider>
        <FlowChatsFilterButton />
      </TooltipProvider>
    </Provider>,
  );
  return screen.getByRole('button', { name: 'Hide Flow chats' });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('FlowChatsFilterButton', () => {
  it('shows Flow chats until pressed, then hides them and stays pressed', () => {
    const store = createStore();
    const button = renderButton(store);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(button);

    expect(store.get(hideFlowChatsAtom)).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows Flow chats again on a second press', () => {
    const store = createStore();
    store.set(hideFlowChatsAtom, true);
    const button = renderButton(store);

    fireEvent.click(button);

    expect(store.get(hideFlowChatsAtom)).toBe(false);
  });
});
