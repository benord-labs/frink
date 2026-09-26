// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusChatInput } from '@/lib/focus-chat-input';
import { useSidebarNavigation } from './use-sidebar-navigation';

/**
 * Escape from the focused sidebar hands focus back to the chat input. Destinations that unmount the
 * chat surface — the Flows dashboard — must not have that handoff land on whatever unrelated input
 * happens to be on screen, nor drop focus to <body>, where the next Escape reaches the
 * destination's own close handler.
 */
function mountSidebar(onSelectionKey?: (action: 'clear' | 'delete') => boolean): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  container.tabIndex = -1;
  const row = document.createElement('button');
  row.setAttribute('data-sidebar-item', '');
  row.setAttribute('data-item-id', 'chat-1');
  row.setAttribute('data-item-type', 'chat');
  container.append(row);
  document.body.append(container);

  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  ref.current = container;
  const { unmount } = renderHook(() =>
    useSidebarNavigation(ref, {
      onSelectChat: vi.fn(),
      onToggleCodebase: vi.fn(),
      isCodebaseExpanded: () => false,
      onSelectionKey,
    }),
  );
  return { container, unmount };
}

/** The chat surface AgentsDestinationPane mounts for chat and Work Queue, but never for Flows. */
function mountChatSurface(): HTMLElement {
  const surface = document.createElement('section');
  surface.setAttribute('data-work-queue-return-target', '');
  const input = document.createElement('div');
  input.setAttribute('data-chat-input', 'true');
  input.setAttribute('contenteditable', 'true');
  input.tabIndex = 0;
  surface.append(input);
  document.body.append(surface);
  return input;
}

/** The Flows dashboard renders a flow-search box — an <input>, but not a chat input. */
function mountFlowsSearch(): HTMLInputElement {
  const page = document.createElement('div');
  const search = document.createElement('input');
  search.placeholder = 'Search flows...';
  page.append(search);
  document.body.append(page);
  return search;
}

const pressEscape = (container: HTMLElement) =>
  act(() => {
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('sidebar Escape focus handoff', () => {
  it('returns focus to the chat input when the chat surface is mounted', () => {
    const chatInput = mountChatSurface();
    const { container, unmount } = mountSidebar();
    container.focus();

    pressEscape(container);

    expect(document.activeElement).toBe(chatInput);
    unmount();
  });

  it('does not hijack the flow search box on the Flows dashboard', () => {
    const search = mountFlowsSearch();
    const { container, unmount } = mountSidebar();
    container.focus();

    pressEscape(container);

    expect(document.activeElement).not.toBe(search);
    unmount();
  });

  it('keeps focus in the sidebar when there is no chat surface to hand off to', () => {
    mountFlowsSearch();
    const { container, unmount } = mountSidebar();
    container.focus();

    pressEscape(container);

    expect(document.activeElement).toBe(container);
    expect(document.activeElement).not.toBe(document.body);
    unmount();
  });
});

describe('sidebar keys with a multi-selection', () => {
  it('Escape clears the selection first and keeps focus in the sidebar', () => {
    mountChatSurface();
    const onSelectionKey = vi.fn(() => true);
    const { container, unmount } = mountSidebar(onSelectionKey);
    container.focus();

    pressEscape(container);

    expect(onSelectionKey).toHaveBeenCalledWith('clear');
    expect(document.activeElement).toBe(container);
    unmount();
  });

  it('Delete and Backspace ask to delete the selection', () => {
    const onSelectionKey = vi.fn(() => true);
    const { container, unmount } = mountSidebar(onSelectionKey);
    for (const key of ['Delete', 'Backspace']) {
      act(() => {
        container.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    }
    expect(onSelectionKey.mock.calls).toEqual([['delete'], ['delete']]);
    unmount();
  });

  // Deleting chats is irreversible; a Backspace typed into a field must only edit the field.
  it('ignores Backspace typed into an input inside the sidebar', () => {
    const onSelectionKey = vi.fn(() => true);
    const { container, unmount } = mountSidebar(onSelectionKey);
    const field = document.createElement('input');
    container.append(field);
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(onSelectionKey).not.toHaveBeenCalled();
    unmount();
  });
});

/**
 * The handoff above relies on focusChatInput reporting whether it actually hit a target — its
 * documented fallback chain ends at a bare `textarea, input`, which is why the caller scopes it.
 */
describe('focusChatInput contract', () => {
  it('focuses the chat input and reports the hit', () => {
    const input = mountChatSurface();

    expect(focusChatInput()).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('reports a miss when no input exists, leaving focus untouched', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    anchor.focus();

    expect(focusChatInput()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('reports a miss for a scope that holds no input, ignoring one outside it', () => {
    const outside = mountFlowsSearch();
    const scope = document.createElement('div');
    document.body.append(scope);

    expect(focusChatInput(scope)).toBe(false);
    expect(document.activeElement).not.toBe(outside);
  });

  /** Unscoped, the bare-input fallback is exactly what would grab the flow-search box. */
  it('falls back to a bare input when unscoped, which is why callers scope it', () => {
    const search = mountFlowsSearch();

    expect(focusChatInput()).toBe(true);
    expect(document.activeElement).toBe(search);
  });
});
