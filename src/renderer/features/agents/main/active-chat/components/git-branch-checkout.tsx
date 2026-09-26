/* eslint-disable max-lines, max-lines-per-function */
/**
 * Git branch checkout (switch/create/delete) shared by ChatInputContextBar and new-chat local row.
 * Render-prop API so callers place branchPicker inside a flex row and dialogNodes as siblings.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { WORKSPACE_LOCK_REASON } from '@/lib/workspace-context/use-workspace-context-lock';
import { transformBranchData } from '../../../../../lib/branch-normalization';
import { BranchSelector } from '../../../components/branch-selector';
import { CreateBranchDialog } from '../../../components/create-branch-dialog';
import { DeleteBranchDialog } from '../../../components/delete-branch-dialog';
import { STRINGS } from '../../new-chat-form-constants';

type GitBranchCheckoutRenderProps = {
  canShowGitPicker: boolean;
  branchPicker: ReactNode;
  dialogNodes: ReactNode;
};

type GitBranchCheckoutProps = {
  worktreePath: string | null | undefined;
  currentBranch: string | null | undefined;
  isActive?: boolean;
  /**
   * The chat is busy, so checking out would move files under a running agent: the picker degrades
   * to the caller's read-only chip and the shortcut answers with the reason. Deleting stays
   * available — isBranchDeletable already excludes the current branch and any branch checked out
   * elsewhere, so no delete can touch the tree in use.
   */
  locked?: boolean;
  /** Applied to the wrapper around BranchSelector */
  branchPickerClassName?: string;
  children: (props: GitBranchCheckoutRenderProps) => ReactNode;
};

function canShowGitBranchCheckoutPicker(
  worktreePath: string | null | undefined,
  currentBranch: string | null | undefined,
): boolean {
  return Boolean(worktreePath && currentBranch && currentBranch.length > 0);
}

export function GitBranchCheckout({
  worktreePath,
  currentBranch,
  isActive = true,
  locked = false,
  branchPickerClassName,
  children,
}: GitBranchCheckoutProps) {
  const hasGitContext = canShowGitBranchCheckoutPicker(worktreePath, currentBranch);
  const canShowGitPicker = hasGitContext && !locked;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteSearch, setDeleteSearch] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);

  const utils = trpc.useUtils();
  // Keyed to git context, not to the lock: the query is not polled, so keeping it warm through a run
  // costs nothing and spares the picker a loading tick the moment the lock releases. Deleting also
  // stays available while locked, and it needs this list.
  const { data: branchData, isLoading: isBranchesLoading } = trpc.changes.getBranches.useQuery(
    { worktreePath: worktreePath || '' },
    { enabled: hasGitContext },
  );

  const switchBranchMutation = trpc.changes.switchBranch.useMutation({
    onSuccess: (_data, variables) => {
      void utils.changes.getBranches.invalidate();
      void utils.changes.getStatus.invalidate({ worktreePath: variables.worktreePath });
      setPopoverOpen(false);
      setCreateDialogOpen(false);
    },
    onError: (error) => {
      toast.error(error.message);
      setPopoverOpen(true);
    },
  });
  const deleteBranchMutation = trpc.changes.deleteBranch.useMutation({
    onSuccess: (_data, variables) => {
      void utils.changes.getBranches.invalidate({ worktreePath: variables.worktreePath });
      void utils.changes.getStatus.invalidate({ worktreePath: variables.worktreePath });
      setDeleteConfirmOpen(false);
      setPendingDeleteBranch(null);
      toast.success(`Deleted branch '${variables.branch}'`);
    },
    onError: (error, variables) => {
      const message = error.message.toLowerCase();
      if (message.includes('not fully merged')) {
        toast.error(
          `Branch '${variables.branch}' is not fully merged. Merge it first before deleting.`,
        );
        return;
      }
      toast.error(error.message);
    },
  });

  const branches = useMemo(() => (branchData ? transformBranchData(branchData) : []), [branchData]);

  const selectedBranchType = useMemo<'local' | 'remote' | undefined>(() => {
    if (!currentBranch) return undefined;
    return branches.find((b) => b.name === currentBranch)?.type;
  }, [branches, currentBranch]);

  const isBranchDeletable = useCallback(
    (branch: (typeof branches)[number]) =>
      branch.type === 'local' &&
      !branch.protected &&
      !branch.isDefault &&
      branch.name !== currentBranch &&
      !branch.checkedOutIn,
    [currentBranch],
  );

  const deletableBranches = useMemo(
    () => branches.filter((branch) => isBranchDeletable(branch)),
    [branches, isBranchDeletable],
  );

  const handleBranchSelect = useCallback(
    (name: string, _type: 'local' | 'remote') => {
      if (!worktreePath) return;
      switchBranchMutation.mutate({ worktreePath, branch: name });
    },
    [worktreePath, switchBranchMutation],
  );

  const handleCreateBranch = useCallback(() => {
    setPopoverOpen(false);
    setCreateDialogOpen(true);
  }, []);

  const openDeleteConfirm = useCallback((branchName: string) => {
    setPendingDeleteBranch(branchName);
    setDeleteConfirmOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!worktreePath || !pendingDeleteBranch) return;
    deleteBranchMutation.mutate({
      worktreePath,
      branch: pendingDeleteBranch,
      force: false,
      deleteRemote: false,
    });
  }, [deleteBranchMutation, pendingDeleteBranch, worktreePath]);

  const handleBranchCreated = useCallback(
    (branchName: string) => {
      if (!worktreePath) return;
      switchBranchMutation.mutate({ worktreePath, branch: branchName });
    },
    [worktreePath, switchBranchMutation],
  );

  const dialogBranches = useMemo(
    () =>
      branches.map((b) => ({
        name: b.name,
        isDefault: b.isDefault,
        committedAt: b.committedAt,
        protected: b.protected,
      })),
    [branches],
  );

  // Checking out is unavailable while locked, and so is the popover it lives in: leaving popoverOpen
  // set would spring the picker open by itself the moment the lock releases. Say why, since a
  // picker closing under the user's cursor otherwise looks like a glitch.
  useEffect(() => {
    if (!locked) return;
    setCreateDialogOpen(false);
    if (!popoverOpen) return;
    setPopoverOpen(false);
    toast.info(WORKSPACE_LOCK_REASON);
  }, [locked, popoverOpen]);

  useEffect(() => {
    const openBranchPicker = () => {
      if (!isActive) return;
      if (locked) {
        toast.info(WORKSPACE_LOCK_REASON);
        return;
      }
      if (!canShowGitPicker) {
        toast.info('No git branch context is available in this chat.');
        return;
      }
      setPopoverOpen(true);
    };

    // Deliberately NOT locked: a deletable branch is never the one in use.
    const openBranchDeleteDialog = () => {
      if (!isActive) return;
      if (!hasGitContext || !worktreePath) {
        toast.info('No git branch context is available in this chat.');
        return;
      }
      if (deletableBranches.length === 0) {
        toast.info('No deletable branches found.');
        return;
      }
      setDeleteDialogOpen(true);
    };

    window.addEventListener('branches:open-picker', openBranchPicker);
    window.addEventListener('branches:open-delete-picker', openBranchDeleteDialog);
    return () => {
      window.removeEventListener('branches:open-picker', openBranchPicker);
      window.removeEventListener('branches:open-delete-picker', openBranchDeleteDialog);
    };
  }, [canShowGitPicker, deletableBranches.length, hasGitContext, isActive, locked, worktreePath]);

  const branchPicker = canShowGitPicker ? (
    <div className={cn('min-w-0', branchPickerClassName)}>
      <BranchSelector
        branches={branches}
        selectedBranch={currentBranch ?? ''}
        selectedBranchType={selectedBranchType}
        defaultBranch={branchData?.defaultBranch ?? STRINGS.BRANCH_DEFAULT}
        isLoading={isBranchesLoading}
        onBranchSelect={handleBranchSelect}
        onCreateBranch={handleCreateBranch}
        isOpen={popoverOpen}
        onOpenChange={setPopoverOpen}
        searchQuery={branchSearch}
        onSearchChange={setBranchSearch}
        isBranchDeletable={isBranchDeletable}
        onDeleteBranch={openDeleteConfirm}
      />
    </div>
  ) : null;

  // Gated on git context, not the lock: a lock must CLOSE an open dialog (the effect above), never
  // unmount it mid-interaction — a Radix modal torn down while open can strand pointer-events on
  // body. Delete also stays reachable while locked.
  const dialogNodes = hasGitContext ? (
    <>
      <CreateBranchDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectPath={worktreePath ?? ''}
        branches={dialogBranches}
        defaultBranch={branchData?.defaultBranch ?? STRINGS.BRANCH_DEFAULT}
        onBranchCreated={handleBranchCreated}
      />
      <DeleteBranchDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        branches={deletableBranches}
        searchQuery={deleteSearch}
        onSearchChange={setDeleteSearch}
        onBranchSelect={openDeleteConfirm}
      />
      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          setDeleteConfirmOpen(open);
          if (!open) {
            setPendingDeleteBranch(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteBranch
                ? `Delete '${pendingDeleteBranch}' from your local repository? This action cannot be undone.`
                : 'Delete this branch from your local repository? This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleDeleteConfirm();
              }}
              disabled={deleteBranchMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBranchMutation.isPending ? 'Deleting...' : 'Delete branch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  ) : null;

  return children({ canShowGitPicker, branchPicker, dialogNodes });
}
