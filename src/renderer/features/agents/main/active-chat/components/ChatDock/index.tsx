import type { ReactElement, ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { useSplitPaneBranchBarSync } from '../../../../ui/split-view-container/SplitPaneBranchBarHeightSync';
import { ChatInputContextBar } from '../ChatInputContextBar';
import { ScrollToBottomButton } from '../ScrollToBottomButton';

type Props = {
  /** The transcript scroller. It fills the region and runs under the stack. */
  transcript: ReactNode;
  /** The bottom stack. Each member is a full-width `px-2` row around a `max-w-2xl` column, and
   *  only the column takes pointer events, so the gutters reach the transcript's scrollbar. */
  children: ReactNode;
  /** Shows the scroll-to-bottom button. ScrollToBottomButton's prop doc defines the signal. */
  hasLeftBottom: boolean;
  onScrollToBottom: () => void;
  worktreePath: string | null;
  currentBranch?: string | null;
  workspaceFolderName?: string | null;
  chatId: string;
  /** Forwarded to the workspace row's prompt-cache timer; null while streaming or unknown. */
  promptCacheExpiresAt?: number | null;
  isActive: boolean;
  /** Split pane index when in multi-pane layout; omit in single-pane chat. */
  splitPaneIndex?: number;
};

/** ChatDock — floats the chat's bottom stack over the end of the transcript; the stack's height,
 *  `--chat-dock-height`, pads the transcript's bottom (decision transparency-glass-surfaces). */
export function ChatDock({
  transcript,
  children,
  hasLeftBottom,
  onScrollToBottom,
  worktreePath,
  currentBranch,
  workspaceFolderName,
  chatId,
  promptCacheExpiresAt,
  isActive,
  splitPaneIndex,
}: Props): ReactElement {
  const regionRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  // Set before first paint, then on each resize. offsetHeight and borderBoxSize are unzoomed CSS
  // px, the unit the var is read in under a split pane's CSS zoom; getBoundingClientRect is zoomed.
  useLayoutEffect(() => {
    const region = regionRef.current;
    const stack = stackRef.current;
    if (!region || !stack) return;
    region.style.setProperty('--chat-dock-height', `${stack.offsetHeight}px`);
    const observer = new ResizeObserver(([entry]) => {
      region.style.setProperty('--chat-dock-height', `${entry.borderBoxSize[0].blockSize}px`);
    });
    observer.observe(stack);
    return () => observer.disconnect();
  }, []);

  // Visible sub-chat tab only: keep-alive tabs must not register a height (see ChatTabsRenderer).
  const shouldSyncFloor = splitPaneIndex !== undefined && isActive;
  const { measureRef, outerStyle } = useSplitPaneBranchBarSync(splitPaneIndex, shouldSyncFloor);

  // Same shell as the stack members (`px-2` + `max-w-2xl`), so the row tracks the composer's edges.
  const workspaceRow = (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl px-2">
      <ChatInputContextBar
        worktreePath={worktreePath}
        currentBranch={currentBranch}
        workspaceFolderName={workspaceFolderName}
        isActive={isActive}
        chatId={chatId}
        promptCacheExpiresAt={promptCacheExpiresAt}
      />
    </div>
  );

  return (
    <>
      {/* No mask, filter, opacity, transform, will-change or overflow clip on the region or stack:
          each makes the glass backdrop sharp or traps the composer's fixed menus and focus ring. */}
      <div ref={regionRef} className="relative flex min-h-0 flex-1 flex-col">
        {transcript}
        <div
          ref={stackRef}
          data-chat-dock
          className="pointer-events-none absolute inset-x-0 -bottom-2 z-10 [&>*>*]:pointer-events-auto"
        >
          {children}
          <ScrollToBottomButton hasLeftBottom={hasLeftBottom} onScrollToBottom={onScrollToBottom} />
        </div>
      </div>
      {/* The floor. Split panes share its height so composer bottoms line up across panes. */}
      <div className="shrink-0 pt-2">
        {shouldSyncFloor ? (
          <div
            className="flex min-w-0 shrink-0 flex-col justify-end"
            data-testid="split-pane-branch-footer-sync"
            style={outerStyle}
          >
            <div ref={measureRef} className="min-w-0">
              {workspaceRow}
            </div>
          </div>
        ) : (
          workspaceRow
        )}
      </div>
    </>
  );
}
