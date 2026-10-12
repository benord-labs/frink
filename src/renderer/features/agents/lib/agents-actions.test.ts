// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { executeAgentAction } from './agents-actions';

describe('agents-actions', () => {
  it('opens file search dialog for file-search action', async () => {
    const setFileSearchDialogOpen = vi.fn();

    const result = await executeAgentAction(
      'file-search',
      { setFileSearchDialogOpen, canShowFilesSidebar: true },
      'hotkey',
    );

    expect(result.success).toBe(true);
    expect(setFileSearchDialogOpen).toHaveBeenCalledWith(true);
  });

  it('activates file-tree search for find-in-files action', async () => {
    const activateFilesSidebarSearch = vi.fn();

    const result = await executeAgentAction(
      'find-in-files',
      { activateFilesSidebarSearch, canShowFilesSidebar: true },
      'hotkey',
    );

    expect(result.success).toBe(true);
    expect(activateFilesSidebarSearch).toHaveBeenCalledTimes(1);
  });

  it('activates active-pane search in split view', async () => {
    const activateFilesSidebarSearch = vi.fn();
    const activateActivePaneFileSearch = vi.fn();

    const result = await executeAgentAction(
      'find-in-files',
      {
        activateFilesSidebarSearch,
        activateActivePaneFileSearch,
        canShowFilesSidebar: true,
        isSplitActive: true,
      },
      'hotkey',
    );

    expect(result.success).toBe(true);
    expect(activateActivePaneFileSearch).toHaveBeenCalledTimes(1);
    expect(activateFilesSidebarSearch).not.toHaveBeenCalled();
  });

  it('no-ops find-in-files when no local sidebar is available', async () => {
    const activateFilesSidebarSearch = vi.fn();

    const result = await executeAgentAction(
      'find-in-files',
      { activateFilesSidebarSearch, canShowFilesSidebar: false, isSplitActive: false },
      'hotkey',
    );

    expect(result.success).toBe(true);
    expect(activateFilesSidebarSearch).not.toHaveBeenCalled();
  });

  it('dispatches event for open-file-in-editor action', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const result = await executeAgentAction('open-file-in-editor', {}, 'hotkey');

    expect(result.success).toBe(true);
    expect(dispatchSpy).toHaveBeenCalled();
    const event = dispatchSpy.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).type).toBe('file-viewer:open-in-editor');
  });

  it('dispatches event for open-branch-picker action', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const result = await executeAgentAction('open-branch-picker', {}, 'hotkey');
    expect(result.success).toBe(true);
    const event = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe('branches:open-picker');
  });

  it('dispatches event for open-branch-delete-picker action', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const result = await executeAgentAction('open-branch-delete-picker', {}, 'hotkey');
    expect(result.success).toBe(true);
    const event = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe('branches:open-delete-picker');
  });

  it('dispatches event for collapse-all-sidebar action', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const result = await executeAgentAction('collapse-all-sidebar', {}, 'hotkey');
    expect(result.success).toBe(true);
    const event = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe('sidebar:collapse-all');
  });

  it('dispatches event for toggle-archived action', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const result = await executeAgentAction('toggle-archived', {}, 'hotkey');
    expect(result.success).toBe(true);
    const event = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(event.type).toBe('sidebar:toggle-archived');
  });

  // These actions are built by one factory, so a mis-wired argument would swap two
  // event names without breaking anything else. Pin each id to its event.
  it('keeps every event-dispatch action pointed at its own event', async () => {
    const expected = [
      ['open-file-in-editor', 'file-viewer:open-in-editor'],
      ['open-branch-picker', 'branches:open-picker'],
      ['open-branch-delete-picker', 'branches:open-delete-picker'],
      ['collapse-all-sidebar', 'sidebar:collapse-all'],
      ['toggle-archived', 'sidebar:toggle-archived'],
    ] as const;

    for (const [actionId, eventName] of expected) {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      await executeAgentAction(actionId, {}, 'hotkey');
      expect((dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent).type).toBe(eventName);
      dispatchSpy.mockRestore();
    }
  });

  // Archive is a chat-pane shortcut: the layout wires its handler only while the chat destination
  // is visible on desktop, so Work Queue, Flows, Settings and mobile never own or run it.
  describe('archive-agent', () => {
    it('archives through the handler the chat destination wired', async () => {
      const archiveFocusedChat = vi.fn();

      const result = await executeAgentAction('archive-agent', { archiveFocusedChat }, 'hotkey');

      expect(result.success).toBe(true);
      expect(archiveFocusedChat).toHaveBeenCalledTimes(1);
    });

    it('is unavailable when no destination wired a handler', async () => {
      const result = await executeAgentAction('archive-agent', {}, 'hotkey');

      expect(result.success).toBe(false);
    });
  });

  // Both sidebar shortcuts share one destination capability, so neither can write persisted
  // sidebar state on a destination that never renders the sidebar (Flows, Settings, mobile).
  describe('sidebar actions', () => {
    const SIDEBAR_ACTION_IDS = ['toggle-sidebar', 'focus-sidebar'] as const;

    it.each(SIDEBAR_ACTION_IDS)('%s acts where the sidebar can render', async (actionId) => {
      const setSidebarOpen = vi.fn();
      const result = await executeAgentAction(
        actionId,
        { setSidebarOpen, canToggleUnifiedSidebar: true },
        'hotkey',
      );

      expect(result.success).toBe(true);
      expect(setSidebarOpen).toHaveBeenCalledTimes(1);
    });

    it.each(SIDEBAR_ACTION_IDS)(
      '%s leaves sidebar state untouched where the sidebar cannot render',
      async (actionId) => {
        const setSidebarOpen = vi.fn();
        const result = await executeAgentAction(
          actionId,
          { setSidebarOpen, canToggleUnifiedSidebar: false },
          'hotkey',
        );

        expect(result.success).toBe(false);
        expect(setSidebarOpen).not.toHaveBeenCalled();
      },
    );

    // Default-deny: losing the capability wire must disable the shortcut outright rather than
    // silently resume writing sidebar state on destinations that cannot show it.
    it.each(SIDEBAR_ACTION_IDS)(
      '%s stays inert when the capability is unwired',
      async (actionId) => {
        const setSidebarOpen = vi.fn();
        const result = await executeAgentAction(actionId, { setSidebarOpen }, 'hotkey');

        expect(result.success).toBe(false);
        expect(setSidebarOpen).not.toHaveBeenCalled();
      },
    );
  });

  describe('view zoom actions', () => {
    it('page-zoom-in calls zoomIn', async () => {
      const zoomIn = vi.fn().mockResolvedValue(undefined);
      const result = await executeAgentAction('page-zoom-in', { zoomIn }, 'hotkey');
      expect(result.success).toBe(true);
      expect(zoomIn).toHaveBeenCalledTimes(1);
    });

    it('page-zoom-out calls zoomOut', async () => {
      const zoomOut = vi.fn().mockResolvedValue(undefined);
      const result = await executeAgentAction('page-zoom-out', { zoomOut }, 'hotkey');
      expect(result.success).toBe(true);
      expect(zoomOut).toHaveBeenCalledTimes(1);
    });

    it('zoom-in-grow-pane uses pane zoom and grow when split with 2+ panes', async () => {
      const zoomIn = vi.fn();
      const zoomPaneIn = vi.fn();
      const growPane = vi.fn();
      const result = await executeAgentAction(
        'zoom-in-grow-pane',
        { isSplitActive: true, paneCount: 2, zoomIn, zoomPaneIn, growPane },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomPaneIn).toHaveBeenCalledTimes(1);
      expect(growPane).toHaveBeenCalledTimes(1);
      expect(zoomIn).not.toHaveBeenCalled();
    });

    it('zoom-in-grow-pane uses page zoom when not in split', async () => {
      const zoomIn = vi.fn().mockResolvedValue(undefined);
      const zoomPaneIn = vi.fn();
      const growPane = vi.fn();
      const result = await executeAgentAction(
        'zoom-in-grow-pane',
        { isSplitActive: false, paneCount: 1, zoomIn, zoomPaneIn, growPane },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomIn).toHaveBeenCalledTimes(1);
      expect(zoomPaneIn).not.toHaveBeenCalled();
      expect(growPane).not.toHaveBeenCalled();
    });

    it('zoom-out-shrink-pane uses pane zoom and shrink when split with 2+ panes', async () => {
      const zoomOut = vi.fn();
      const zoomPaneOut = vi.fn();
      const shrinkPane = vi.fn();
      const result = await executeAgentAction(
        'zoom-out-shrink-pane',
        { isSplitActive: true, paneCount: 2, zoomOut, zoomPaneOut, shrinkPane },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomPaneOut).toHaveBeenCalledTimes(1);
      expect(shrinkPane).toHaveBeenCalledTimes(1);
      expect(zoomOut).not.toHaveBeenCalled();
    });

    it('zoom-out-shrink-pane uses page zoom when not in split', async () => {
      const zoomOut = vi.fn().mockResolvedValue(undefined);
      const zoomPaneOut = vi.fn();
      const shrinkPane = vi.fn();
      const result = await executeAgentAction(
        'zoom-out-shrink-pane',
        { isSplitActive: false, paneCount: 1, zoomOut, zoomPaneOut, shrinkPane },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomOut).toHaveBeenCalledTimes(1);
      expect(zoomPaneOut).not.toHaveBeenCalled();
      expect(shrinkPane).not.toHaveBeenCalled();
    });

    it('zoom-pane-in is not available outside split', async () => {
      const zoomPaneIn = vi.fn();
      const result = await executeAgentAction(
        'zoom-pane-in',
        { isSplitActive: false, paneCount: 1, zoomPaneIn },
        'hotkey',
      );
      expect(result.success).toBe(false);
      expect(zoomPaneIn).not.toHaveBeenCalled();
    });

    it('zoom-pane-in calls zoomPaneIn when split with 2 panes', async () => {
      const zoomPaneIn = vi.fn();
      const result = await executeAgentAction(
        'zoom-pane-in',
        { isSplitActive: true, paneCount: 2, zoomPaneIn },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomPaneIn).toHaveBeenCalledTimes(1);
    });

    it('zoom-pane-out is not available outside split', async () => {
      const zoomPaneOut = vi.fn();
      const result = await executeAgentAction(
        'zoom-pane-out',
        { isSplitActive: false, paneCount: 1, zoomPaneOut },
        'hotkey',
      );
      expect(result.success).toBe(false);
      expect(zoomPaneOut).not.toHaveBeenCalled();
    });

    it('zoom-pane-out calls zoomPaneOut when split with 2 panes', async () => {
      const zoomPaneOut = vi.fn();
      const result = await executeAgentAction(
        'zoom-pane-out',
        { isSplitActive: true, paneCount: 2, zoomPaneOut },
        'hotkey',
      );
      expect(result.success).toBe(true);
      expect(zoomPaneOut).toHaveBeenCalledTimes(1);
    });
  });
});
