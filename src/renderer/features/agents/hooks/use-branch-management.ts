import { useAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type BranchListItem, transformBranchData } from '../../../lib/branch-normalization';
import { trpc } from '../../../lib/trpc';
import { lastSelectedBranchesAtom } from '../atoms';
import { LIMITS } from '../main/new-chat-form-constants';

type Project = {
  id: string;
  path: string;
};

type Branch = BranchListItem;

type Props = {
  project: Project | null;
};

type ReturnValue = {
  branches: Branch[];
  /** The currently checked-out branch in the project's git repo. */
  currentBranch: string | undefined;
  selectedBranch: string;
  selectedBranchType: 'local' | 'remote' | undefined;
  defaultBranch: string | undefined;
  isLoading: boolean;
  branchSearch: string;
  branchPopoverOpen: boolean;
  setSelectedBranch: (branch: string, type?: 'local' | 'remote') => void;
  setBranchSearch: (search: string) => void;
  setBranchPopoverOpen: (open: boolean) => void;
  handleRefreshBranches: () => void;
};

/**
 * Manages branch selection state and operations for a project
 */
export function useBranchManagement({ project }: Props): ReturnValue {
  const [lastSelectedBranches, setLastSelectedBranches] = useAtom(lastSelectedBranchesAtom);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
  const [selectedBranchType, setSelectedBranchType] = useState<'local' | 'remote' | undefined>(
    undefined,
  );

  // Fetch branches from local git repository
  const branchesQuery = trpc.changes.getBranches.useQuery(
    { worktreePath: project?.path || '' },
    {
      enabled: !!project?.path,
      staleTime: LIMITS.BRANCHES_STALE_TIME_MS,
    },
  );

  const fetchRemoteMutation = trpc.changes.fetchRemote.useMutation();

  const handleRefreshBranches = useCallback(() => {
    if (project?.path) {
      fetchRemoteMutation.mutate(
        { worktreePath: project.path },
        {
          onSuccess: () => {
            branchesQuery.refetch();
          },
          onError: (_error) => {},
        },
      );
    }
  }, [project?.path, fetchRemoteMutation, branchesQuery]);

  // Transform branch data to match required format
  const branches = useMemo(
    () => (branchesQuery.data ? transformBranchData(branchesQuery.data) : []),
    [branchesQuery.data],
  );

  const selectedBranch = project?.id ? lastSelectedBranches[project.id]?.name || '' : '';

  const setSelectedBranch = useCallback(
    (branch: string, type?: 'local' | 'remote') => {
      if (project?.id && type) {
        setLastSelectedBranches((prev) => ({
          ...prev,
          [project.id]: { name: branch, type },
        }));
        setSelectedBranchType(type);
      }
    },
    [project?.id, setLastSelectedBranches],
  );

  // Restore selectedBranchType from persisted storage when project changes
  useEffect(() => {
    if (project?.id) {
      const stored = lastSelectedBranches[project.id];
      if (stored?.type) {
        setSelectedBranchType(stored.type);
      } else {
        setSelectedBranchType(undefined);
      }
    } else {
      setSelectedBranchType(undefined);
    }
  }, [project?.id, lastSelectedBranches]);

  // Set default branch when project/branches change
  useEffect(() => {
    if (branchesQuery.data?.defaultBranch && project?.id && !selectedBranch) {
      const defaultBranchObj =
        branches.find(
          (b) => b.name === branchesQuery.data.defaultBranch && b.isDefault && b.type === 'local',
        ) ||
        branches.find(
          (b) => b.name === branchesQuery.data.defaultBranch && b.isDefault && b.type === 'remote',
        );
      const branchType = defaultBranchObj?.type || 'local';
      setSelectedBranch(branchesQuery.data.defaultBranch, branchType);
    }
  }, [branchesQuery.data?.defaultBranch, project?.id, selectedBranch, setSelectedBranch, branches]);

  return {
    branches,
    currentBranch: branchesQuery.data?.current,
    selectedBranch,
    selectedBranchType,
    defaultBranch: branchesQuery.data?.defaultBranch,
    isLoading: branchesQuery.isLoading,
    branchSearch,
    branchPopoverOpen,
    setSelectedBranch,
    setBranchSearch,
    setBranchPopoverOpen,
    handleRefreshBranches,
  };
}
