/**
 * WorktreePicker — thin wrapper around BranchSelector that lists git worktrees.
 * Transforms WorktreeInfo into BranchListItem[] so the UI is identical to the branch picker.
 * Hides itself when no linked worktrees exist.
 *
 * Two modes:
 * - "select" (new-chat): `onSelect` callback, no mutation
 * - "switch" (active-chat): `chatId` provided, calls switchWorktree mutation + invalidates
 */

import { GitFork } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { BranchListItem } from '../../../lib/branch-normalization';
import { trpc } from '../../../lib/trpc';
import { BranchSelector } from './branch-selector';

type BaseProps = {
  /** Main repo path — used to query the worktree list */
  repoPath: string;
  /** Currently active worktree path (null = main repo) */
  selectedPath: string | null;
};

type SelectMode = BaseProps & {
  onSelect: (path: string | null) => void;
  chatId?: never;
};

type SwitchMode = BaseProps & {
  chatId: string;
  onSelect?: never;
};

type WorktreePickerProps = SelectMode | SwitchMode;

type WorktreeEntry = { path: string; branch: string | null; isMain: boolean; prunable: boolean };

/**
 * Derive unique display labels for a list of worktrees.
 * When two worktrees share the same folder name, disambiguates by
 * prepending the parent directory (e.g., "projectA/fix-bug").
 * Returns a Map<worktreePath, label> for O(1) bi-directional lookup.
 */
function buildWorktreeLabels(worktrees: WorktreeEntry[]): Map<string, string> {
  const labels = new Map<string, string>();
  const folderCount = new Map<string, number>();

  for (const wt of worktrees) {
    if (wt.isMain) continue;
    const folder = wt.path.split('/').pop() ?? wt.path;
    folderCount.set(folder, (folderCount.get(folder) ?? 0) + 1);
  }

  for (const wt of worktrees) {
    if (wt.isMain) {
      labels.set(wt.path, 'Main');
      continue;
    }
    const segments = wt.path.split('/');
    const folder = segments.pop() ?? wt.path;
    if ((folderCount.get(folder) ?? 0) > 1) {
      const parent = segments.pop() ?? '';
      labels.set(wt.path, parent ? `${parent}/${folder}` : folder);
    } else {
      labels.set(wt.path, folder);
    }
  }

  return labels;
}

export function WorktreePicker(props: WorktreePickerProps) {
  const { repoPath, selectedPath } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const utils = trpc.useUtils();

  const { data: worktrees = [], isLoading } = trpc.changes.getWorktrees.useQuery(
    { repoPath },
    { enabled: !!repoPath },
  );

  const switchMutation = trpc.chats.switchWorktree.useMutation({
    onSuccess: async (data, variables) => {
      const nextWt = data.worktreePath ?? variables.worktreePath;
      utils.chats.get.setData({ id: variables.chatId }, (old) => {
        if (!old) return old;
        return {
          ...old,
          worktreePath: nextWt,
          branch: data.branch,
          baseBranch: data.baseBranch,
        };
      });
      await utils.chats.get.invalidate({ id: variables.chatId });
      void utils.chats.listByFolder.invalidate();
      void utils.changes.getBranches.invalidate();
      void utils.changes.getStatus.invalidate();
      void utils.changes.getWorktrees.invalidate();
      void utils.files.listDirectory.invalidate();
      setOpen(false);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const labelMap = useMemo(() => buildWorktreeLabels(worktrees), [worktrees]);

  const labelToPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const [path, label] of labelMap) map.set(label, path);
    return map;
  }, [labelMap]);

  const branches: BranchListItem[] = useMemo(
    () =>
      worktrees.map((wt) => ({
        name: labelMap.get(wt.path) ?? wt.path,
        type: 'local' as const,
        protected: wt.isMain,
        isDefault: wt.isMain,
        committedAt: null,
        authorName: null,
        checkedOutIn: wt.prunable ? 'prunable' : null,
      })),
    [worktrees, labelMap],
  );

  const effectivePath = selectedPath ?? repoPath;
  const selectedLabel = labelMap.get(effectivePath) ?? '';

  const handleSelect = useCallback(
    (name: string) => {
      const wtPath = labelToPath.get(name);
      if (!wtPath) return;
      const wt = worktrees.find((w) => w.path === wtPath);
      if (!wt) return;

      if (props.chatId) {
        switchMutation.mutate({ chatId: props.chatId, worktreePath: wt.path });
      } else {
        props.onSelect?.(wt.isMain ? null : wt.path);
        setOpen(false);
      }
    },
    [worktrees, labelToPath, props, switchMutation],
  );

  const hasLinked = worktrees.some((wt) => !wt.isMain);

  if (!isLoading && !hasLinked) return null;

  return (
    <BranchSelector
      branches={branches}
      selectedBranch={selectedLabel}
      selectedBranchType="local"
      defaultBranch=""
      isLoading={isLoading || switchMutation.isPending}
      onBranchSelect={handleSelect}
      isOpen={open}
      onOpenChange={setOpen}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search worktrees..."
      showTypeBadge={false}
      TriggerIcon={GitFork}
    />
  );
}
