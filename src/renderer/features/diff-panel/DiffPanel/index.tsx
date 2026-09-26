import { useCallback, useState } from 'react';
import { useDiffPanelFiles } from '@/lib/hooks/diff-panel/use-diff-panel-files';
import {
  areAllCollapsed,
  toggleAllCollapsed,
  toggleKey,
  withoutKey,
} from '@/lib/utils/diff/diff-code-view-items';
import { InsetGlassSidebarShell } from '@/features/sidebar';
import { DiffFileList } from '../DiffFileList';
import { type DiffHandoffs, DiffPanelHeader } from '../DiffPanelHeader';
import { DiffSummaryBar } from '../DiffSummaryBar';

type DiffPanelProps = {
  chatId: string;
  worktreePath: string;
  onClose: () => void;
  /** Absent where the agent cannot be asked (the narrow-window full-screen view). */
  handoffs?: DiffHandoffs;
  /** Watch the repo itself; set where no chat view is mounted to refresh the diff. */
  watchRepo?: boolean;
};

/** Read-only view of the chat's uncommitted changes. */
export function DiffPanel({
  chatId,
  worktreePath,
  onClose,
  handoffs,
  watchRepo = false,
}: DiffPanelProps) {
  const files = useDiffPanelFiles(chatId, watchRepo ? worktreePath : null);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(new Set());
  const toggleCollapsed = useCallback(
    (key: string) => setCollapsedKeys((prev) => toggleKey(prev, key)),
    [],
  );
  const expand = useCallback(
    (key: string) => setCollapsedKeys((prev) => withoutKey(prev, key)),
    [],
  );

  return (
    <InsetGlassSidebarShell edge="right" glassClassName="rounded-xl">
      <DiffPanelHeader
        worktreePath={worktreePath}
        hasChanges={files.hasChanges}
        allCollapsed={areAllCollapsed(collapsedKeys, files.visibleKeys)}
        onToggleAllCollapsed={() =>
          setCollapsedKeys((prev) => toggleAllCollapsed(prev, files.visibleKeys))
        }
        onClose={onClose}
        handoffs={handoffs}
      />
      {files.hasChanges && (
        <DiffSummaryBar
          shownCount={files.visible.length}
          totalCount={files.totalCount}
          unrenderableCount={files.unrenderableCount}
          additions={files.diffStats.additions}
          deletions={files.diffStats.deletions}
          isFiltered={files.isFiltered}
          onShowAll={files.clearFilter}
        />
      )}
      {files.notice ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {files.notice}
        </div>
      ) : (
        <DiffFileList
          chatId={chatId}
          worktreePath={worktreePath}
          files={files.visible}
          collapsedKeys={collapsedKeys}
          onToggleCollapsed={toggleCollapsed}
          onExpand={expand}
        />
      )}
    </InsetGlassSidebarShell>
  );
}
