// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerConfirm } from '../../../lib/test-utils/sidebar-confirm';
import { flowFilterStub, hoisted, resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar } from './UnifiedSidebar';

// oxlint-disable anti-slop/no-module-mocking -- vitest requires vi.mock per file; these all
// delegate to the shared sidebar-test-harness rather than defining new mock behaviour.
vi.mock('jotai', async (importOriginal) =>
  (await import('./sidebar-test-harness')).makeJotaiMock(
    await importOriginal<typeof import('jotai')>(),
  ),
);
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
vi.mock(
  '../../agents/hooks/use-split-view',
  async () => (await import('./sidebar-test-harness')).splitViewMock,
);
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
vi.mock('./components', async () => (await import('./sidebar-test-harness')).componentsMock);

beforeAll(setupHarness);
afterEach(resetHarness);

function setFolderCounts(projectId: string | null, count: number, flowCount: number) {
  const rows = [{ projectId, count, flowCount }];
  hoisted.chatsListCountsForSidebarData = rows;
}

describe('UnifiedSidebar Flow-chat filter', () => {
  const lastFolderFetch = () => hoisted.chatsListByFolderFetchMock.mock.lastCall?.[0];

  it('loads folder pages without Flow chats while the filter is on', async () => {
    flowFilterStub.hide = true;
    setFolderCounts(null, 3, 1);

    render(<UnifiedSidebar />);

    await waitFor(() => {
      expect(lastFolderFetch()).toMatchObject({ projectIds: null, hideFlowChats: true });
    });
  });

  it('leaves out a folder whose every chat came from a Flow', async () => {
    flowFilterStub.hide = true;
    setFolderCounts(null, 2, 2);

    render(<UnifiedSidebar />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.chatsListByFolderFetchMock).not.toHaveBeenCalled();
  });

  it('reloads every folder under the new filter when it flips', async () => {
    setFolderCounts(null, 2, 1);
    const { rerender } = render(<UnifiedSidebar />);
    await waitFor(() => {
      expect(lastFolderFetch()).toMatchObject({ hideFlowChats: false });
    });

    flowFilterStub.hide = true;
    rerender(<UnifiedSidebar onChatSelect={() => {}} />);

    await waitFor(() => {
      expect(lastFolderFetch()).toMatchObject({ hideFlowChats: true });
    });
  });

  it('still counts hidden Flow chats when confirming a project delete', async () => {
    flowFilterStub.hide = true;
    setFolderCounts('local-p1', 3, 2);
    render(<UnifiedSidebar />);
    // SAFETY: the ProjectsTree double records the props UnifiedSidebar rendered it with.
    const props = hoisted.capturedProjectsTreeProps as {
      onProjectDelete: (projectId: string) => Promise<void>;
    };

    const asked = await answerConfirm(() => props.onProjectDelete('local-p1'), 'cancel');

    expect(asked).toContain('Delete this project and 3 chats?');
  });

  it('hides archived Flow chats too', () => {
    flowFilterStub.hide = true;
    hoisted.archivedChatsData = [
      { id: 'mine', name: 'Mine', taskId: null },
      { id: 'flow', name: 'Flow', taskId: 'task-1' },
    ];
    render(<UnifiedSidebar />);

    fireEvent.click(screen.getByTestId('toggle-archived'));

    // SAFETY: the ArchivedChatsSection double records the props UnifiedSidebar handed it.
    const props = hoisted.capturedArchivedChatsSectionProps as { archivedChats: { id: string }[] };
    expect(props.archivedChats.map((chat) => chat.id)).toEqual(['mine']);
  });
});
