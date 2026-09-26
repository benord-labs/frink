// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom } from '../../../lib/atoms';
import { exitDestinationForSidebarNavigationAtom } from '../../../lib/atoms/agent-navigation-atoms';
import { selectedAgentChatIdAtom } from '../../agents/atoms';
import { filesSidebarOpenAtom } from '../../files-sidebar/atoms';
import { resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar, type UnifiedSidebarHandle } from './UnifiedSidebar';

const local = vi.hoisted(() => ({
  activeOverlay: null as 'settings' | 'workqueue' | null,
  setActiveOverlay: vi.fn(),
  setSelectedChatId: vi.fn(),
  setFilesSidebarOpen: vi.fn(),
  addEmptyPane: vi.fn(),
  cycleLayout: vi.fn(),
  sidebarNavProps: null as Record<string, unknown> | null,
  sidebarFooterProps: null as Record<string, unknown> | null,
  projectsTreeProps: null as Record<string, unknown> | null,
}));

vi.mock('jotai', async (importOriginal) => {
  const harness = await import('./sidebar-test-harness');
  const base = harness.makeJotaiMock(await importOriginal<typeof import('jotai')>());
  return {
    ...base,
    useAtom: (atom: { debugLabel?: string }) => {
      if (atom.debugLabel === 'test-active-overlay') {
        return [local.activeOverlay, local.setActiveOverlay];
      }
      if (atom.debugLabel === 'test-files-sidebar') return [false, local.setFilesSidebarOpen];
      return [null, local.setSelectedChatId];
    },
    useSetAtom: (atom: { debugLabel?: string }) => {
      const baseSetter = base.useSetAtom();
      if (atom.debugLabel === 'test-exit-sidebar-destination') {
        return () => {
          if (local.activeOverlay === null) return false;
          local.setActiveOverlay(null);
          return true;
        };
      }
      return baseSetter;
    },
  };
});
vi.mock('../../../lib/trpc', async () => (await import('./sidebar-test-harness')).trpcMock);
vi.mock(
  '../../agents/stores/agent-chat-store',
  async () => (await import('./sidebar-test-harness')).agentChatStoreMock,
);
vi.mock(
  '../../agents/stores/sub-chat-store',
  async () => (await import('./sidebar-test-harness')).subChatStoreMock,
);
vi.mock(
  '../../../lib/utils/git-status',
  async () => (await import('./sidebar-test-harness')).gitStatusMock,
);
vi.mock('../../agents/hooks/use-split-view', async () => {
  const base = (await import('./sidebar-test-harness')).splitViewMock;
  return {
    ...base,
    useSplitViewActions: () => ({
      ...base.useSplitViewActions(),
      addEmptyPane: local.addEmptyPane,
      cycleLayout: local.cycleLayout,
    }),
  };
});
vi.mock(
  './hooks/use-expansion-state',
  async () => (await import('./sidebar-test-harness')).expansionStateMock,
);
vi.mock(
  './hooks/use-grouped-projects',
  async () => (await import('./sidebar-test-harness')).groupedProjectsMock,
);
vi.mock(
  './hooks/use-sidebar-navigation',
  async () => (await import('./sidebar-test-harness')).sidebarNavigationMock,
);
vi.mock('./hooks/use-chat-dnd', async () => (await import('./sidebar-test-harness')).chatDndMock);
vi.mock(
  './hooks/use-task-aware-chat-actions',
  async () => (await import('./sidebar-test-harness')).taskAwareChatActionsMock,
);
vi.mock('./components', async () => {
  const base = (await import('./sidebar-test-harness')).componentsMock;
  return {
    ...base,
    SidebarNav: (props: Record<string, unknown>) => {
      local.sidebarNavProps = props;
      return (
        <button
          ref={props.workQueueTriggerRef as Ref<HTMLButtonElement>}
          type="button"
          data-testid="work-queue-trigger"
          onClick={props.onShowWorkQueue as () => void}
        >
          Work Queue
        </button>
      );
    },
    SidebarFooter: (props: Record<string, unknown>) => {
      local.sidebarFooterProps = props;
      return null;
    },
    ProjectsTree: (props: Record<string, unknown>) => {
      local.projectsTreeProps = props;
      return null;
    },
  };
});

beforeAll(async () => {
  activeOverlayAtom.debugLabel = 'test-active-overlay';
  exitDestinationForSidebarNavigationAtom.debugLabel = 'test-exit-sidebar-destination';
  filesSidebarOpenAtom.debugLabel = 'test-files-sidebar';
  selectedAgentChatIdAtom.debugLabel = 'test-selected-chat';
  await setupHarness();
});

afterEach(() => {
  resetHarness();
  local.activeOverlay = null;
  for (const mock of [
    local.setActiveOverlay,
    local.setSelectedChatId,
    local.setFilesSidebarOpen,
    local.addEmptyPane,
    local.cycleLayout,
  ]) {
    mock.mockReset();
  }
  local.sidebarNavProps = null;
  local.sidebarFooterProps = null;
  local.projectsTreeProps = null;
});

function expectOverlayClosedBefore(action: ReturnType<typeof vi.fn>): void {
  expect(local.setActiveOverlay).toHaveBeenCalledWith(null);
  expect(local.setActiveOverlay.mock.invocationCallOrder[0]).toBeLessThan(
    action.mock.invocationCallOrder[0],
  );
}

describe('UnifiedSidebar Work Queue destination', () => {
  it('exposes focus restoration for the Work Queue trigger', () => {
    const ref = createRef<UnifiedSidebarHandle>();
    render(<UnifiedSidebar ref={ref} />);
    ref.current?.focusWorkQueueTrigger();
    expect(screen.getByTestId('work-queue-trigger')).toHaveFocus();
  });

  it('opens Work Queue through the shared overlay atom', () => {
    render(<UnifiedSidebar />);
    screen.getByTestId('work-queue-trigger').click();
    expect(local.setActiveOverlay).toHaveBeenCalledWith('workqueue');
  });

  it('exits Work Queue before chat, split, and files actions keep their effects', () => {
    local.activeOverlay = 'workqueue';
    render(<UnifiedSidebar />);
    const nav = local.sidebarNavProps as {
      onNewChat: () => void;
      onAddSplitPane: () => void;
      onCycleLayout: () => void;
    };
    const footer = local.sidebarFooterProps as { onToggleFilesSidebar: () => void };

    for (const [run, effect] of [
      [nav.onNewChat, local.setSelectedChatId],
      [nav.onAddSplitPane, local.addEmptyPane],
      [nav.onCycleLayout, local.cycleLayout],
      [footer.onToggleFilesSidebar, local.setFilesSidebarOpen],
    ] as const) {
      local.setActiveOverlay.mockClear();
      effect.mockClear();
      run();
      expectOverlayClosedBefore(effect);
    }
  });

  it('returns to retained chats without starting a new chat', () => {
    local.activeOverlay = 'workqueue';
    render(<UnifiedSidebar />);
    const nav = local.sidebarNavProps as { onViewChats: () => void };

    nav.onViewChats();

    expect(local.setActiveOverlay).toHaveBeenCalledWith(null);
    expect(local.setSelectedChatId).not.toHaveBeenCalled();
    expect(local.addEmptyPane).not.toHaveBeenCalled();
  });

  it('exits Work Queue before selecting a chat', () => {
    local.activeOverlay = 'workqueue';
    render(<UnifiedSidebar />);
    const projects = local.projectsTreeProps as {
      chatActions: { onChatSelect: (chatId: string) => void };
    };
    projects.chatActions.onChatSelect('chat-1');
    expect(local.setSelectedChatId).toHaveBeenCalledWith('chat-1');
    expectOverlayClosedBefore(local.setSelectedChatId);
  });

  it('consumes a Settings return to Work Queue before New Chat', () => {
    local.activeOverlay = 'settings';
    render(<UnifiedSidebar />);
    const nav = local.sidebarNavProps as { onNewChat: () => void };

    nav.onNewChat();

    expectOverlayClosedBefore(local.setSelectedChatId);
  });
});
