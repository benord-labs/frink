// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEditorTabCycleDirection } from '@/lib/code-editor/tabs';
import type { CustomHotkeysConfig } from '@/lib/hotkeys';
import { matchesHotkey, useAgentsHotkeys } from './agents-hotkeys-manager';

function HotkeysHarness(props: Parameters<typeof useAgentsHotkeys>[0]) {
  useAgentsHotkeys(props);
  return <div data-testid="hotkeys-harness" />;
}

describe('useAgentsHotkeys', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('triggers find-in-files with Cmd+Shift+G', () => {
    const activateFilesSidebarSearch = vi.fn();
    render(
      <HotkeysHarness
        canShowFilesSidebar={true}
        onBeforeAction={() => true}
        activateFilesSidebarSearch={activateFilesSidebarSearch}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', metaKey: true, shiftKey: true }));
    expect(activateFilesSidebarSearch).toHaveBeenCalledTimes(1);
  });

  it('still triggers find-in-files while typing in an input', () => {
    const activateFilesSidebarSearch = vi.fn();
    render(
      <>
        <input id="typing" />
        <HotkeysHarness
          canShowFilesSidebar={true}
          activateFilesSidebarSearch={activateFilesSidebarSearch}
        />
      </>,
    );

    const input = document.getElementById('typing') as HTMLInputElement;
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'g', metaKey: true, shiftKey: true, bubbles: true }),
    );
    expect(activateFilesSidebarSearch).toHaveBeenCalledTimes(1);
  });

  it('routes Cmd+Shift+G to active split pane search', () => {
    const activateFilesSidebarSearch = vi.fn();
    const activateActivePaneFileSearch = vi.fn();
    render(
      <HotkeysHarness
        canShowFilesSidebar={true}
        isSplitActive={true}
        activateFilesSidebarSearch={activateFilesSidebarSearch}
        activateActivePaneFileSearch={activateActivePaneFileSearch}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', metaKey: true, shiftKey: true }));
    expect(activateActivePaneFileSearch).toHaveBeenCalledTimes(1);
    expect(activateFilesSidebarSearch).not.toHaveBeenCalled();
  });

  it('routes Cmd+F to editor find when target is inside code editor panel', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);

    const panel = document.createElement('div');
    panel.setAttribute('data-code-editor-panel', 'true');
    const child = document.createElement('div');
    panel.appendChild(child);
    document.body.appendChild(panel);

    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
    const editorFindEvent = dispatchSpy.mock.calls.find(
      ([event]) => (event as Event).type === 'editor:find',
    );
    expect(editorFindEvent).toBeTruthy();
  });

  it('triggers open branch picker with Cmd+Shift+B', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true }));
    const event = dispatchSpy.mock.calls.find(
      ([evt]) => (evt as Event).type === 'branches:open-picker',
    );
    expect(event).toBeTruthy();
  });

  it('triggers open branch picker while typing in an input (global hotkey)', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(
      <>
        <input id="typing" />
        <HotkeysHarness canShowFilesSidebar={true} />
      </>,
    );
    const input = document.getElementById('typing') as HTMLInputElement;
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true, bubbles: true }),
    );
    const event = dispatchSpy.mock.calls.find(
      ([evt]) => (evt as Event).type === 'branches:open-picker',
    );
    expect(event).toBeTruthy();
  });

  it('dispatches one branch picker event per keydown', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, shiftKey: true }));
    const branchOpenEvents = dispatchSpy.mock.calls.filter(
      ([evt]) => (evt as Event).type === 'branches:open-picker',
    );
    expect(branchOpenEvents).toHaveLength(1);
  });

  it('triggers open branch delete picker with Cmd+Shift+Backspace', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, shiftKey: true }),
    );
    const event = dispatchSpy.mock.calls.find(
      ([evt]) => (evt as Event).type === 'branches:open-delete-picker',
    );
    expect(event).toBeTruthy();
  });

  it('dispatches one delete picker event per keydown', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, shiftKey: true }),
    );
    const deleteEvents = dispatchSpy.mock.calls.filter(
      ([evt]) => (evt as Event).type === 'branches:open-delete-picker',
    );
    expect(deleteEvents).toHaveLength(1);
  });

  it('toggles archived chats with Cmd+Shift+A, even while typing in an input', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(
      <>
        <input id="typing" />
        <HotkeysHarness canShowFilesSidebar={true} />
      </>,
    );
    document.getElementById('typing')?.focus();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));

    const toggles = dispatchSpy.mock.calls.filter(
      ([evt]) => (evt as Event).type === 'sidebar:toggle-archived',
    );
    expect(toggles).toHaveLength(1);
  });

  it('does not toggle archived chats on Shift+A alone', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<HotkeysHarness canShowFilesSidebar={true} />);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', shiftKey: true }));

    const toggles = dispatchSpy.mock.calls.filter(
      ([evt]) => (evt as Event).type === 'sidebar:toggle-archived',
    );
    expect(toggles).toHaveLength(0);
  });

  // Shortcut IDs are matched to action IDs by a derived map rather than a spelled-out
  // table, so a rebound shortcut must still reach its action -- and the default it
  // replaced must stop firing.
  it('honours a custom binding and drops the default it replaced', () => {
    const activateFilesSidebarSearch = vi.fn();
    render(
      <HotkeysHarness
        canShowFilesSidebar={true}
        activateFilesSidebarSearch={activateFilesSidebarSearch}
        customHotkeysConfig={{ version: 1, bindings: { 'find-in-files': 'cmd+alt+k' } }}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, altKey: true }));
    expect(activateFilesSidebarSearch).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', metaKey: true, shiftKey: true }));
    expect(activateFilesSidebarSearch).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// matchesHotkey unit tests
// =============================================================================

function event(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('matchesHotkey – plus key', () => {
  // cmd+shift+plus: the renderer binding for zoom-in-grow-pane
  it('matches cmd+shift+plus when Shift is held (code=Equal)', () => {
    expect(
      matchesHotkey(
        event({ key: '+', code: 'Equal', metaKey: true, shiftKey: true }),
        'cmd+shift+plus',
      ),
    ).toBe(true);
  });

  it('does NOT match cmd+shift+plus when Shift is not held (code=Equal) — bug fix', () => {
    expect(
      matchesHotkey(
        event({ key: '=', code: 'Equal', metaKey: true, shiftKey: false }),
        'cmd+shift+plus',
      ),
    ).toBe(false);
  });

  // cmd+plus: would be used for a binding that doesn't require shift
  it('matches cmd+plus when Shift is not held (code=Equal)', () => {
    expect(
      matchesHotkey(event({ key: '=', code: 'Equal', metaKey: true, shiftKey: false }), 'cmd+plus'),
    ).toBe(true);
  });

  it('does NOT match cmd+plus when Shift is held (code=Equal)', () => {
    expect(
      matchesHotkey(event({ key: '+', code: 'Equal', metaKey: true, shiftKey: true }), 'cmd+plus'),
    ).toBe(false);
  });

  // cmd+alt+plus: the renderer binding for zoom-pane-in; UK workaround (alt clears shiftKey)
  it('matches cmd+alt+plus when Alt is held (code=Equal, UK-style key)', () => {
    expect(
      matchesHotkey(
        event({ key: '≠', code: 'Equal', metaKey: true, altKey: true, shiftKey: false }),
        'cmd+alt+plus',
      ),
    ).toBe(true);
  });

  it('matches cmd+alt+plus when Alt is held with standard + key', () => {
    expect(
      matchesHotkey(
        event({ key: '+', code: 'Equal', metaKey: true, altKey: true, shiftKey: false }),
        'cmd+alt+plus',
      ),
    ).toBe(true);
  });

  // Numpad
  it('matches cmd+shift+plus via NumpadAdd with Shift', () => {
    expect(
      matchesHotkey(
        event({ key: '+', code: 'NumpadAdd', metaKey: true, shiftKey: true }),
        'cmd+shift+plus',
      ),
    ).toBe(true);
  });

  it('does NOT match cmd+shift+plus via NumpadAdd without Shift', () => {
    expect(
      matchesHotkey(
        event({ key: '+', code: 'NumpadAdd', metaKey: true, shiftKey: false }),
        'cmd+shift+plus',
      ),
    ).toBe(false);
  });
});

describe('matchesHotkey – minus key', () => {
  // cmd+shift+minus: the renderer binding for zoom-out-shrink-pane
  it('matches cmd+shift+minus when Shift is held', () => {
    expect(
      matchesHotkey(
        event({ key: '_', code: 'Minus', metaKey: true, shiftKey: true }),
        'cmd+shift+minus',
      ),
    ).toBe(true);
  });

  it('does NOT match cmd+shift+minus when Shift is not held — bug fix', () => {
    expect(
      matchesHotkey(
        event({ key: '-', code: 'Minus', metaKey: true, shiftKey: false }),
        'cmd+shift+minus',
      ),
    ).toBe(false);
  });

  // cmd+minus: page-zoom-out (no shift)
  it('matches cmd+minus when Shift is not held', () => {
    expect(
      matchesHotkey(
        event({ key: '-', code: 'Minus', metaKey: true, shiftKey: false }),
        'cmd+minus',
      ),
    ).toBe(true);
  });

  it('does NOT match cmd+minus when Shift is held', () => {
    expect(
      matchesHotkey(event({ key: '_', code: 'Minus', metaKey: true, shiftKey: true }), 'cmd+minus'),
    ).toBe(false);
  });

  // cmd+alt+minus: the renderer binding for zoom-pane-out
  it('matches cmd+alt+minus when Alt is held', () => {
    expect(
      matchesHotkey(
        event({ key: '-', code: 'Minus', metaKey: true, altKey: true, shiftKey: false }),
        'cmd+alt+minus',
      ),
    ).toBe(true);
  });

  // Numpad
  it('matches cmd+shift+minus via NumpadSubtract with Shift', () => {
    expect(
      matchesHotkey(
        event({ key: '-', code: 'NumpadSubtract', metaKey: true, shiftKey: true }),
        'cmd+shift+minus',
      ),
    ).toBe(true);
  });

  it('does NOT match cmd+shift+minus via NumpadSubtract without Shift', () => {
    expect(
      matchesHotkey(
        event({ key: '-', code: 'NumpadSubtract', metaKey: true, shiftKey: false }),
        'cmd+shift+minus',
      ),
    ).toBe(false);
  });
});

// =============================================================================
// Editor tab cycling: global early binding + CodeEditorPanel fallback together
// =============================================================================

describe('editor tab cycling – global manager and panel fallback', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  /**
   * Mirrors CodeEditorPanel's wiring: a document capture listener that runs after
   * the manager's window capture listener and only acts on events inside the panel.
   */
  function setup(config: CustomHotkeysConfig, isMac: boolean) {
    const cycles: number[] = [];
    const onCycle = (e: Event) => cycles.push((e as CustomEvent<number>).detail);
    window.addEventListener('editor:cycle-pane-group', onCycle);

    render(
      <>
        <div data-testid="panel">
          <textarea data-testid="monaco" />
        </div>
        <HotkeysHarness customHotkeysConfig={config} />
      </>,
    );
    const panel = document.querySelector('[data-testid="panel"]')!;
    const monaco = document.querySelector('[data-testid="monaco"]')!;
    const fallback = (e: KeyboardEvent) => {
      if (!panel.contains(e.target as Node)) return;
      const dir = getEditorTabCycleDirection(e, config, isMac);
      if (dir === null) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('editor:cycle-pane-group', { detail: dir }));
    };
    document.addEventListener('keydown', fallback, true);

    const press = (init: KeyboardEventInit) =>
      monaco.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    const teardown = () => {
      document.removeEventListener('keydown', fallback, true);
      window.removeEventListener('editor:cycle-pane-group', onCycle);
    };
    return { cycles, press, teardown };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('fires exactly once for the macOS default (no double cycle)', async () => {
    const { cycles, press, teardown } = setup({ version: 1, bindings: {} }, true);
    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    await waitFor(() => expect(cycles).toEqual([1]));
    await settle();
    expect(cycles).toEqual([1]);
    teardown();
  });

  it('fires exactly once for Ctrl+Shift+[ on Windows/Linux via the fallback', async () => {
    const { cycles, press, teardown } = setup({ version: 1, bindings: {} }, false);
    press({ key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(cycles).toEqual([-1]));
    await settle();
    expect(cycles).toEqual([-1]);
    teardown();
  });

  it('after a rebind, the custom combo cycles once and the old default is inert', async () => {
    const config: CustomHotkeysConfig = { version: 1, bindings: { 'next-pane-group': 'cmd+alt+l' } };
    const { cycles, press, teardown } = setup(config, true);
    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    await settle();
    expect(cycles).toEqual([]);
    press({ key: '¬', code: 'KeyL', metaKey: true, altKey: true });
    await waitFor(() => expect(cycles).toEqual([1]));
    await settle();
    expect(cycles).toEqual([1]);
    teardown();
  });

  it('an unbound action cycles nowhere', async () => {
    const config: CustomHotkeysConfig = { version: 1, bindings: { 'next-pane-group': null } };
    const { cycles, press, teardown } = setup(config, false);
    press({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true });
    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    await settle();
    expect(cycles).toEqual([]);
    teardown();
  });
});
