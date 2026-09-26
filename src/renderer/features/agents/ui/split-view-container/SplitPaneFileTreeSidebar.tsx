import { ResizableSidebar } from '@/components/ui/resizable-sidebar';
import { cn } from '@/lib/utils';
import { splitPaneFileTreeWidthAtom } from '../../../../features/files-sidebar/atoms';
import {
  SPLIT_FILE_TREE_MAX_WIDTH,
  SPLIT_FILE_TREE_MIN_WIDTH,
} from '../../../../features/files-sidebar/constants';
import {
  PaneFileTree,
  type PaneFileTreeHandle,
} from '../../../../features/files-sidebar/PaneFileTree';

type SplitPaneFileTreeSidebarProps = {
  projectPath: string;
  isWorktree?: boolean;
  chatId: string;
  paneIndex: number;
  onFileTreeRef: (handle: PaneFileTreeHandle | null) => void;
  onCloseFileTree?: () => void;
};

/** Shared resizable file tree sidebar for split panes (GridPane and LinearPane). */
export function SplitPaneFileTreeSidebar({
  projectPath,
  isWorktree,
  chatId,
  paneIndex,
  onFileTreeRef,
  onCloseFileTree,
}: SplitPaneFileTreeSidebarProps) {
  return (
    <ResizableSidebar
      isOpen={true}
      onClose={onCloseFileTree}
      widthAtom={splitPaneFileTreeWidthAtom}
      side="left"
      minWidth={SPLIT_FILE_TREE_MIN_WIDTH}
      maxWidth={SPLIT_FILE_TREE_MAX_WIDTH}
      animationDuration={0}
      initialWidth={0}
      exitWidth={0}
      showResizeTooltip={true}
      disableClickToClose={true}
      className={cn(
        'shrink-0 border-r border-border/30 overflow-hidden',
        isWorktree
          ? 'bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--tl-background)))]'
          : 'bg-tl-background',
      )}
    >
      <div
        className={cn(
          'flex flex-col h-full min-w-0 overflow-hidden rounded-md border',
          isWorktree ? 'border-primary/70' : 'border-border/30',
        )}
      >
        {isWorktree && <div className="h-[2px] shrink-0 bg-primary/50" aria-hidden />}
        <PaneFileTree
          ref={onFileTreeRef}
          projectPath={projectPath}
          chatId={chatId}
          paneIndex={paneIndex}
          isWorktree={isWorktree}
          onClose={onCloseFileTree}
        />
      </div>
    </ResizableSidebar>
  );
}
