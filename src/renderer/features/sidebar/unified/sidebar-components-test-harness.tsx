// @vitest-environment happy-dom
// biome-ignore-all lint/style/useNamingConvention: mirrors mocked React component export names
/* eslint-disable project-structure/folder-structure, project-structure/independent-modules -- shared test-only component doubles cannot use a test suffix without Vitest collecting this helper as a suite. */

import { createContext, type ReactNode } from 'react';
import type { IdSelectionStore } from '../../../lib/tree-navigation';
import type { ChatSelectionChipProps } from './components/ChatSelection';

type CapturedComponentProps = {
  capturedProjectsTreeProps: Record<string, unknown> | null;
  capturedSidebarDialogsProps: Record<string, unknown> | null;
  capturedArchivedChatsSectionProps: Record<string, unknown> | null;
  capturedChatSelectionChipProps: ChatSelectionChipProps | null;
};

/** Component doubles shared by the UnifiedSidebar suites. */
export function makeSidebarComponentsMock(captured: CapturedComponentProps) {
  return {
    SidebarHeader: ({
      searchQuery,
      onSearchChange,
      showFlowChatsFilter,
    }: {
      searchQuery: string;
      onSearchChange: (query: string) => void;
      showFlowChatsFilter: boolean;
    }) => (
      <input
        data-testid="sidebar-header"
        data-flow-filter={String(showFlowChatsFilter)}
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
      />
    ),
    ChatSelectionContext: createContext<IdSelectionStore | null>(null),
    ChatSelectionChip: (props: ChatSelectionChipProps): ReactNode => {
      captured.capturedChatSelectionChipProps = props;
      return null;
    },
    ProjectsTree: (props: Record<string, unknown>) => {
      captured.capturedProjectsTreeProps = props;
      return <div data-testid="projects-tree" />;
    },
    ArchivedChatsSection: (props: Record<string, unknown>) => {
      captured.capturedArchivedChatsSectionProps = props;
      return <div data-testid="archived-chats" />;
    },
    SidebarDialogs: (props: { showWorkQueue?: boolean }) => {
      captured.capturedSidebarDialogsProps = props as Record<string, unknown>;
      return <div data-testid="sidebar-dialogs">{props.showWorkQueue ? 'open' : 'closed'}</div>;
    },
    SidebarNav: ({
      inboxTaskCount,
      pendingReviewCount,
      runningTaskCount,
      needsAttentionTaskCount,
      failedTaskCount,
    }: {
      inboxTaskCount: number;
      pendingReviewCount: number;
      runningTaskCount: number;
      needsAttentionTaskCount: number;
      failedTaskCount: number;
    }) => (
      <div data-testid="sidebar-nav-counts">
        {`${inboxTaskCount}:${pendingReviewCount}:${runningTaskCount}:${needsAttentionTaskCount}:${failedTaskCount}`}
      </div>
    ),
    SidebarFooter: ({ onToggleArchived }: { onToggleArchived?: () => void }) => (
      <button type="button" data-testid="toggle-archived" onClick={onToggleArchived}>
        toggle
      </button>
    ),
  };
}
