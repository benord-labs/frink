/**
 * Workspace context under the chat input: folder first, then worktree and branch. One line at every
 * width: git controls that no longer fit move behind an ellipsis and stay the same pickers there.
 */

import { useAtomValue } from 'jotai';
import { Folder, GitBranch } from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';
import { LeafLabel } from '@/components/ui/leaf-label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePriorityOverflow } from '@/hooks/usePriorityOverflow';
import { trpc } from '@/lib/trpc';
import { heldChatIdsAtom } from '@/lib/stores/active-transport-registry';
import { cn } from '@/lib/utils';
import {
  useWorkspaceContextLock,
  WORKSPACE_LOCK_REASON,
} from '@/lib/workspace-context/use-workspace-context-lock';
import { loadingSubChatsAtom } from '../../../atoms';
import { PromptCacheTimer } from '../../../ui/PromptCacheTimer';
import { WorktreePicker } from '../../../components/worktree-picker';
import { ContextOverflowMenu, type OverflowRow } from './ContextOverflowMenu';
import { deriveWorktreeLabel } from './derive-worktree-label';
import { GitBranchCheckout } from './git-branch-checkout';
import { WorktreeIndicator } from './WorktreeIndicator';

/** Tailwind `gap-x-2`, which the overflow measurement has to account for. */
const GAP_PX = 8;

type WorktreeEntry = { path: string; isMain: boolean };

/** "WT: Main" for the repo's own checkout, else the path-derived name. */
function deriveStaticWorktreeLabel(
  worktreePath: string,
  worktrees: WorktreeEntry[],
  isWorktreesError: boolean,
): string {
  // Do not treat an empty worktree list as "main only" when the query failed — fall back to the path.
  if (isWorktreesError) return deriveWorktreeLabel(worktreePath).worktreeLabel;
  const match = worktrees.find((w) => w.path === worktreePath);
  return match?.isMain ? 'WT: Main' : deriveWorktreeLabel(worktreePath).worktreeLabel;
}

type WorktreeSlotArgs = {
  worktreePath: string | null | undefined;
  chatId: string | undefined;
  locked: boolean;
  worktrees: WorktreeEntry[];
  isWorktreesLoading: boolean;
  isWorktreesError: boolean;
};

/** What renders in the worktree slot, and whether it is the switchable picker. */
type WorktreeSlot = { node: ReactNode; interactive: boolean };
const EMPTY_WORKTREE_SLOT: WorktreeSlot = { node: null, interactive: false };

/** Linked worktrees are known, or the list failed and the path is the only evidence. */
function hasWorktreeChoice(worktrees: WorktreeEntry[], isWorktreesError: boolean): boolean {
  return isWorktreesError || worktrees.some((wt) => !wt.isMain);
}

/** Switching needs a chat to re-point and a trustworthy list with somewhere else to go. */
function canSwitchWorktree(
  worktrees: WorktreeEntry[],
  isWorktreesError: boolean,
  chatId: string | undefined,
): boolean {
  return Boolean(chatId) && !isWorktreesError && worktrees.some((wt) => !wt.isMain);
}

function pickerSlot(worktreePath: string, chatId: string): WorktreeSlot {
  return {
    node: <WorktreePicker repoPath={worktreePath} selectedPath={worktreePath} chatId={chatId} />,
    interactive: true,
  };
}

function indicatorSlot(
  { worktreePath, worktrees, isWorktreesError }: WorktreeSlotArgs & { worktreePath: string },
  lockedFromSwitching: boolean,
): WorktreeSlot {
  return {
    node: (
      <WorktreeIndicator
        worktreeLabel={deriveStaticWorktreeLabel(worktreePath, worktrees, isWorktreesError)}
        worktreePath={worktreePath}
        lockedReason={lockedFromSwitching ? WORKSPACE_LOCK_REASON : undefined}
      />
    ),
    interactive: false,
  };
}

/**
 * A worktree chip only where a choice exists. Main-only shows nothing; an unloaded list is unknown
 * rather than empty, so the chip waits instead of mounting a picker that may vanish.
 */
function resolveWorktreeSlot(args: WorktreeSlotArgs): WorktreeSlot {
  const { worktreePath, chatId, locked, worktrees, isWorktreesLoading, isWorktreesError } = args;
  if (!worktreePath || isWorktreesLoading) return EMPTY_WORKTREE_SLOT;
  if (!hasWorktreeChoice(worktrees, isWorktreesError)) return EMPTY_WORKTREE_SLOT;
  const canSwitch = canSwitchWorktree(worktrees, isWorktreesError, chatId);
  if (canSwitch && !locked) return pickerSlot(worktreePath, chatId ?? '');
  return indicatorSlot({ ...args, worktreePath }, locked && canSwitch);
}

/** Up to half the row and never truncating before the git chips: it is what tells panes apart. */
function FolderChip({ folder }: { folder: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-1.5"
          aria-label={`Folder: ${folder}`}
        >
          <Folder className="h-3 w-3 shrink-0 text-muted-foreground/80" aria-hidden />
          <span className="truncate" aria-hidden>
            {folder}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {folder}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * While locked the read-only chip IS the picker, so the reason rides its accessible name as well as
 * its title: a title alone never reliably reaches assistive tech, and nothing else explains the lock.
 */
function ReadOnlyBranchChip({ branch, locked }: { branch: string; locked: boolean }) {
  const suffix = locked ? ` — ${WORKSPACE_LOCK_REASON}` : '';
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      aria-label={`Branch: ${branch}${suffix}`}
      title={`${branch}${suffix}`}
    >
      <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground/80" aria-hidden />
      <LeafLabel text={branch} />
    </span>
  );
}

type ContextRowProps = {
  folder: string;
  promptCacheExpiresAt: number | null;
  gitItems: OverflowRow[];
  overflow: ReturnType<typeof usePriorityOverflow>;
  className?: string;
};

/** The row itself: folder, then the git chips that fit, then the ellipsis holding the rest. */
function ContextRow({
  folder,
  promptCacheExpiresAt,
  gitItems,
  overflow,
  className,
}: ContextRowProps) {
  const { containerRef, moreRef, setItemRef, visibleFrom } = overflow;
  return (
    <section
      aria-label="Workspace context"
      data-testid="chat-input-branch-bar"
      className={cn(
        // The composer above already ends in pb-2, so the row's own space goes below it.
        '@container/context-row flex w-full min-w-0 items-center gap-x-2 overflow-hidden px-3 pt-0.5 pb-2 text-xs text-muted-foreground',
        className,
      )}
    >
      {folder ? <FolderChip folder={folder} /> : null}
      {/* Reference, not a control: narrow rows (split panes) drop it rather than crowd the chips. */}
      <PromptCacheTimer
        expiresAt={promptCacheExpiresAt}
        className="@max-[26rem]/context-row:hidden"
      />
      <div
        ref={containerRef}
        className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-x-2"
      >
        {gitItems.slice(visibleFrom).map((item, index) => (
          <div
            key={item.key}
            ref={setItemRef(visibleFrom + index)}
            className="min-w-0 max-w-[14rem] shrink-0"
          >
            {item.node}
          </div>
        ))}
        {visibleFrom > 0 ? (
          <ContextOverflowMenu ref={moreRef} rows={gitItems.slice(0, visibleFrom)} />
        ) : null}
      </div>
    </section>
  );
}

type ChatInputContextBarProps = {
  currentBranch: string | null | undefined;
  workspaceFolderName: string | null | undefined;
  worktreePath?: string | null;
  isActive?: boolean;
  className?: string;
  /** Parent chat id — when set with worktreePath, WorktreePicker can switch worktrees */
  chatId?: string;
  /** The open sub-chat's prompt-cache expiry (epoch ms); null while streaming or unknown. */
  promptCacheExpiresAt?: number | null;
};

/** Chat-wide, not per sub-chat: every sub-chat tab shares this worktree, so an idle tab must not
 * offer a checkout into a tree a sibling's agent (or its held background work) is using. */
function useIsChatLive(chatId: string | undefined): boolean {
  const loadingSubChats = useAtomValue(loadingSubChatsAtom);
  const heldChatIds = useAtomValue(heldChatIdsAtom);
  if (!chatId) return false;
  return [...loadingSubChats.values()].includes(chatId) || heldChatIds.has(chatId);
}

export const ChatInputContextBar = memo(function ChatInputContextBar({
  currentBranch,
  workspaceFolderName,
  worktreePath,
  isActive = true,
  className,
  chatId,
  promptCacheExpiresAt = null,
}: ChatInputContextBarProps) {
  const {
    data: worktrees = [],
    isLoading: isWorktreesLoading,
    isError: isWorktreesError,
  } = trpc.changes.getWorktrees.useQuery(
    { repoPath: worktreePath || '' },
    { enabled: Boolean(worktreePath) },
  );

  const locked = useWorkspaceContextLock(chatId, useIsChatLive(chatId));

  const folder = workspaceFolderName?.trim() ?? '';
  const branch = currentBranch?.trim() ?? '';
  const worktree = useMemo(
    () =>
      resolveWorktreeSlot({
        worktreePath,
        chatId,
        locked,
        worktrees,
        isWorktreesLoading,
        isWorktreesError,
      }),
    [worktreePath, chatId, locked, worktrees, isWorktreesLoading, isWorktreesError],
  );

  // Worktree overflows before branch. The key names everything that changes a chip's width: labels,
  // which control renders in each slot, and the worktree query both worktree controls label from.
  const overflow = usePriorityOverflow(
    (worktree.node ? 1 : 0) + (branch ? 1 : 0),
    GAP_PX,
    JSON.stringify([
      worktreePath ?? '',
      branch,
      folder,
      locked,
      worktree.interactive,
      isWorktreesError,
      worktrees.map((wt) => wt.path),
    ]),
  );

  return (
    <GitBranchCheckout
      worktreePath={worktreePath}
      currentBranch={currentBranch}
      isActive={isActive}
      locked={locked}
      branchPickerClassName="min-w-0"
    >
      {({ canShowGitPicker, branchPicker, dialogNodes }) => {
        const gitItems: OverflowRow[] = [];
        if (worktree.node)
          gitItems.push({ key: 'worktree', name: 'Worktree', node: worktree.node });
        if (branch) {
          const node = canShowGitPicker ? (
            branchPicker
          ) : (
            <ReadOnlyBranchChip branch={branch} locked={locked && Boolean(worktreePath)} />
          );
          gitItems.push({ key: 'branch', name: 'Branch', node });
        }
        return (
          <>
            <ContextRow
              folder={folder}
              promptCacheExpiresAt={promptCacheExpiresAt}
              gitItems={gitItems}
              overflow={overflow}
              className={className}
            />
            {dialogNodes}
          </>
        );
      }}
    </GitBranchCheckout>
  );
});
