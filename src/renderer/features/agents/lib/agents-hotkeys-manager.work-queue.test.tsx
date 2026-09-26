// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkQueueDestination } from '../../../lib/work-queue/use-work-queue-destination';
import { useAgentsHotkeys } from './agents-hotkeys-manager';

function Harness(props: Parameters<typeof useAgentsHotkeys>[0]) {
  useAgentsHotkeys(props);
  return null;
}

function WorkQueueBranchHarness({ setActiveOverlay }: { setActiveOverlay: (value: null) => void }) {
  let activeOverlay: 'workqueue' | null = 'workqueue';
  const { prepareForAgentsHotkey } = useWorkQueueDestination({
    isMobile: false,
    isSplitActive: false,
    setActiveOverlay,
    exitWorkQueueForNavigation: () => {
      if (activeOverlay !== 'workqueue') return false;
      activeOverlay = null;
      setActiveOverlay(null);
      return true;
    },
    fillActivePane: vi.fn(),
    selectChat: vi.fn(),
    focusWorkQueueTrigger: vi.fn(),
  });
  useAgentsHotkeys({
    onBeforeAction: prepareForAgentsHotkey,
    isSplitActive: true,
    paneCount: 2,
  });
  return null;
}

function WorkQueueSidebarHarness({
  setActiveOverlay,
  setSidebarOpen,
  canToggleUnifiedSidebar,
}: {
  setActiveOverlay: (value: null) => void;
  setSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  canToggleUnifiedSidebar: boolean;
}) {
  const { prepareForAgentsHotkey } = useWorkQueueDestination({
    isMobile: false,
    isSplitActive: false,
    setActiveOverlay,
    exitWorkQueueForNavigation: () => {
      setActiveOverlay(null);
      return true;
    },
    fillActivePane: vi.fn(),
    selectChat: vi.fn(),
    focusWorkQueueTrigger: vi.fn(),
  });
  useAgentsHotkeys({
    onBeforeAction: prepareForAgentsHotkey,
    setSidebarOpen,
    canToggleUnifiedSidebar,
  });
  return null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useAgentsHotkeys destination preparation', () => {
  it('prepares the chat destination before running a files action', async () => {
    const callOrder: string[] = [];
    const onBeforeAction = vi.fn(async (actionId: string) => {
      callOrder.push(`before:${actionId}`);
      return true;
    });
    const setFilesSidebarOpen = vi.fn(() => {
      callOrder.push('files');
    });
    render(
      <Harness
        onBeforeAction={onBeforeAction}
        canShowFilesSidebar={true}
        isFilesSidebarOpen={false}
        setFilesSidebarOpen={setFilesSidebarOpen}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true }));

    await waitFor(() => expect(setFilesSidebarOpen).toHaveBeenCalledWith(true));
    expect(callOrder).toEqual(['before:toggle-files', 'files']);
  });

  it('holds overlapping branch events until the Work Queue exit frame resolves', async () => {
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    const setActiveOverlay = vi.fn();
    const onOpenBranch = vi.fn();
    window.addEventListener('branches:open-picker', onOpenBranch);
    try {
      render(<WorkQueueBranchHarness setActiveOverlay={setActiveOverlay} />);
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true, shiftKey: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          code: 'KeyB',
          metaKey: true,
          shiftKey: true,
          repeat: true,
        }),
      );

      await waitFor(() => expect(setActiveOverlay).toHaveBeenCalledWith(null));
      expect(setActiveOverlay).toHaveBeenCalledOnce();
      expect(requestAnimationFrameMock).toHaveBeenCalledOnce();
      expect(onOpenBranch).not.toHaveBeenCalled();
      act(() => frameCallback?.(0));
      await waitFor(() => expect(onOpenBranch).toHaveBeenCalledOnce());
    } finally {
      window.removeEventListener('branches:open-picker', onOpenBranch);
    }
  });

  it('toggles the sidebar without leaving the Work Queue', async () => {
    const setActiveOverlay = vi.fn();
    const setSidebarOpen = vi.fn();
    render(
      <WorkQueueSidebarHarness
        setActiveOverlay={setActiveOverlay}
        setSidebarOpen={setSidebarOpen}
        canToggleUnifiedSidebar={true}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true }));

    await waitFor(() => expect(setSidebarOpen).toHaveBeenCalledOnce());
    expect(setActiveOverlay).not.toHaveBeenCalled();
  });

  it('ignores the sidebar hotkey on a destination that cannot show the sidebar', async () => {
    const setActiveOverlay = vi.fn();
    const setSidebarOpen = vi.fn();
    render(
      <WorkQueueSidebarHarness
        setActiveOverlay={setActiveOverlay}
        setSidebarOpen={setSidebarOpen}
        canToggleUnifiedSidebar={false}
      />,
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: true }));

    await act(async () => {});
    expect(setSidebarOpen).not.toHaveBeenCalled();
    expect(setActiveOverlay).not.toHaveBeenCalled();
  });

  it('suppresses a repeated close-split while the Work Queue exit frame is pending', async () => {
    let frameCallback: FrameRequestCallback | null = null;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
    const setActiveOverlay = vi.fn();
    const onRemovePane = vi.fn();
    window.addEventListener('split:remove-active-pane', onRemovePane);
    try {
      render(<WorkQueueBranchHarness setActiveOverlay={setActiveOverlay} />);
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, shiftKey: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'w',
          code: 'KeyW',
          metaKey: true,
          shiftKey: true,
          repeat: true,
        }),
      );

      await waitFor(() => expect(setActiveOverlay).toHaveBeenCalledOnce());
      expect(requestAnimationFrameMock).toHaveBeenCalledOnce();
      expect(onRemovePane).not.toHaveBeenCalled();
      act(() => frameCallback?.(0));
      await waitFor(() => expect(onRemovePane).toHaveBeenCalledOnce());
    } finally {
      window.removeEventListener('split:remove-active-pane', onRemovePane);
    }
  });
});
