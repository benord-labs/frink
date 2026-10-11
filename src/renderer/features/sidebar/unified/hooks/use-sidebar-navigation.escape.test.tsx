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
function mountSidebar(onSelectionKey?: (action: 'clear' | 'delete') => boolean) {
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
  const { result, unmount } = renderHook(() =>
    useSidebarNavigation(ref, {
      onSelectChat: vi.fn(),
      onToggleCodebase: vi.fn(),
      isCodebaseExpanded: () => false,
      onSelectionKey,
      selectedChatId: 'chat-1',
    }),
  );
  return { container, row, result, unmount };
}

const repoB = { gitRemote: 'repo-b', displayName: 'repo-b', chats: [{ id: 'chat-2' }] };

/** A tree whose second project, `repo-b`, is collapsed and holds the active chat `chat-2`. */
function mountCollapsedProject({ rendersChat }: { rendersChat: boolean }) {
  const { container, row, unmount } = mountSidebar();
  row.scrollIntoView = vi.fn();
  const project = document.createElement('button');
  project.setAttribute('data-sidebar-item', '');
  project.setAttribute('data-item-id', 'repo-b');
  project.setAttribute('data-item-type', 'codebase');
  project.scrollIntoView = vi.fn();
  container.append(project);
  unmount();

  const expanded = new Set<string>();
  const ref = { current: container };
  const hook = renderHook(() =>
    useSidebarNavigation(ref, {
      onSelectChat: vi.fn(),
      onToggleCodebase: (key) => {
        expanded.add(key);
        if (!rendersChat) return;
        const chat = document.createElement('button');
        chat.setAttribute('data-sidebar-item', '');
        chat.setAttribute('data-item-id', 'chat-2');
        chat.setAttribute('data-item-type', 'chat');
        chat.scrollIntoView = vi.fn();
        container.append(chat);
      },
      isCodebaseExpanded: (key) => expanded.has(key),
      codebases: [repoB],
      selectedChatId: 'chat-2',
    }),
  );
  return { container, result: hook.result, unmount: hook.unmount };
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

describe('sidebar auto-highlight', () => {
  it('highlights and scrolls to the active chat on an explicit sidebar focus', () => {
    const { container, row, result, unmount } = mountSidebar();
    row.scrollIntoView = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));

    act(() => result.current.focusActiveItem());

    expect(document.activeElement).toBe(container);
    expect(result.current.focusedItemId).toBe('chat-1');
    expect(row.scrollIntoView).toHaveBeenCalled();
    unmount();
  });

  it('expands the collapsed project holding the active chat and focuses its row', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { container, result, unmount } = mountCollapsedProject({ rendersChat: true });

    act(() => result.current.focusActiveItem());

    expect(document.activeElement).toBe(container);
    expect(result.current.focusedItemId).toBe('chat-2');
    unmount();
  });

  it('lands on the project row when the expanded project does not render the chat', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { result, unmount } = mountCollapsedProject({ rendersChat: false });

    act(() => result.current.focusActiveItem());

    expect(result.current.focusedItemId).toBe('repo-b');
    unmount();
  });

  it('moves an existing keyboard highlight to the active chat', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { container, result, unmount } = mountCollapsedProject({ rendersChat: true });
    act(() => {
      container.focus();
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(result.current.focusedItemId).toBe('chat-1');

    act(() => result.current.focusActiveItem());

    expect(result.current.focusedItemId).toBe('chat-2');
    unmount();
  });

  // A dialog closing after a delete restores focus to the tree; that must not scroll it.
  it('does not scroll when focus merely returns to the tree', () => {
    const { container, row, result, unmount } = mountSidebar();
    row.scrollIntoView = vi.fn();

    act(() => container.focus());

    expect(result.current.focusedItemId).toBeNull();
    expect(row.scrollIntoView).not.toHaveBeenCalled();
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
