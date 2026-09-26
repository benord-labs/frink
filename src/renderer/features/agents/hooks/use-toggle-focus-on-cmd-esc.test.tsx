// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useToggleFocusOnCmdEsc } from './use-toggle-focus-on-cmd-esc';

function fireModifiedEscape(target: EventTarget, modifier: 'metaKey' | 'ctrlKey') {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    [modifier]: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('useToggleFocusOnCmdEsc', () => {
  it.each(['metaKey', 'ctrlKey'] as const)(
    'does not intercept Escape with %s while Work Queue is visible',
    (modifier) => {
      const editor = { focus: vi.fn(), blur: vi.fn() };
      const workQueueButton = document.createElement('button');
      const buttonListener = vi.fn();
      workQueueButton.dataset.agentsDestination = 'workqueue';
      workQueueButton.addEventListener('keydown', buttonListener);
      document.body.append(workQueueButton);

      renderHook(() => useToggleFocusOnCmdEsc({ current: editor }));

      const event = fireModifiedEscape(workQueueButton, modifier);

      expect(event.defaultPrevented).toBe(false);
      expect(buttonListener).toHaveBeenCalledOnce();
      expect(editor.focus).not.toHaveBeenCalled();
      expect(editor.blur).not.toHaveBeenCalled();
    },
  );

  it('leaves Cmd+Escape alone while its pane chat is hidden behind a side panel', () => {
    const editor = { focus: vi.fn(), blur: vi.fn() };
    const pane = document.createElement('section');
    pane.dataset.paneIndex = '0';
    const chat = document.createElement('div');
    chat.dataset.paneChat = '';
    let chatVisible = false;
    chat.checkVisibility = () => chatVisible;
    pane.append(chat);
    document.body.append(pane);

    renderHook(() => useToggleFocusOnCmdEsc({ current: editor }, 0));

    expect(fireModifiedEscape(window, 'metaKey').defaultPrevented).toBe(false);
    expect(editor.focus).not.toHaveBeenCalled();
    chatVisible = true;
    expect(fireModifiedEscape(window, 'metaKey').defaultPrevented).toBe(true);
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it('prevents Cmd+Escape and focuses the editor while chat is visible', () => {
    const editor = { focus: vi.fn(), blur: vi.fn() };

    renderHook(() => useToggleFocusOnCmdEsc({ current: editor }));

    const event = fireModifiedEscape(window, 'metaKey');

    expect(event.defaultPrevented).toBe(true);
    expect(editor.focus).toHaveBeenCalledOnce();
    expect(editor.blur).not.toHaveBeenCalled();
  });

  it('blurs a focused chat input on Ctrl+Escape while chat is visible', () => {
    const editor = { focus: vi.fn(), blur: vi.fn() };
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();

    renderHook(() => useToggleFocusOnCmdEsc({ current: editor }));

    const event = fireModifiedEscape(input, 'ctrlKey');

    expect(event.defaultPrevented).toBe(true);
    expect(editor.blur).toHaveBeenCalledOnce();
    expect(editor.focus).not.toHaveBeenCalled();
  });
});
