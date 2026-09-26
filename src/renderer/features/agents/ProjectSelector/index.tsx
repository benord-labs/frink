import { Button } from '@benord-labs/frink-primitives';
import { useAtom } from 'jotai';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type NewChatTarget, projectTriggerLabel } from '@/lib/agent-chat/new-chat-target';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { isBuildProjectPath } from '../../../lib/build-project';
import { trpc } from '../../../lib/trpc';
import { validateProjectAgainstList } from '../../../lib/validate-project-against-list';
import { type SelectedProject, selectedProjectAtom } from '../atoms';
import { GitHubCloneDialog } from './GitHubCloneDialog';
import { PickerList, type PickerView } from './PickerList';
import { ProjectIcon } from './ProjectIcon';
import { isProjectSelectionCandidate, type ProjectSelectionCandidate } from './types';

type ProjectSelectorProps = {
  /** When provided (e.g. split-view new-chat pane), use these instead of selectedProjectAtom */
  overrideProject?: SelectedProject | null;
  onOverrideProjectChange?: (project: SelectedProject | null) => void;
  /**
   * When the pane already knows a validated project name (e.g. new-chat parent) but
   * validateProjectAgainstList has not matched yet, show this so the chip is never blank.
   */
  displayNameFallback?: string | null;
  /**
   * Optional git metadata for the trigger icon when `validSelection` is null (e.g. parent
   * label + list race). Merged after {@link SelectedProject} on the atom/override.
   */
  displayNameFallbackGit?: {
    gitOwner?: string | null;
    gitProvider?: 'github' | 'gitlab' | 'bitbucket' | null;
  } | null;
  /**
   * New-chat only (epic sc-788). When provided, the picker shows "General chat" + "New project"
   * items. Target: 'unset' (trigger reads "Open project", sends to general chat) · 'general'
   * (explicitly chose general) · 'new' (sending scaffolds a Frink-managed project). Omitted by
   * non-new-chat callers (e.g. flow editor), which then see only the project list + open/clone.
   */
  newChatTarget?: NewChatTarget;
  onNewChatTargetChange?: (target: NewChatTarget) => void;
};

// Override (split-view pane) wins over the shared atom only when BOTH the value and
// its setter are supplied; otherwise fall back to the atom-backed selection.
function resolveProjectSelection(
  overrideProject: SelectedProject | null | undefined,
  onOverrideProjectChange: ((project: SelectedProject | null) => void) | undefined,
  atomProject: SelectedProject | null,
  setAtomProject: (update: SelectedProject | null) => void,
): {
  selectedProject: SelectedProject | null;
  setSelectedProject: (project: SelectedProject | null) => void;
} {
  return {
    selectedProject:
      overrideProject !== undefined && onOverrideProjectChange !== undefined
        ? overrideProject
        : atomProject,
    setSelectedProject:
      overrideProject !== undefined && onOverrideProjectChange !== undefined
        ? onOverrideProjectChange
        : setAtomProject,
  };
}

export function ProjectSelector({
  overrideProject,
  onOverrideProjectChange,
  displayNameFallback,
  displayNameFallbackGit,
  newChatTarget,
  onNewChatTargetChange,
}: ProjectSelectorProps = {}) {
  const isNewChatContext = onNewChatTargetChange !== undefined;
  const [atomProject, setAtomProject] = useAtom(selectedProjectAtom);
  const { selectedProject, setSelectedProject } = resolveProjectSelection(
    overrideProject,
    onOverrideProjectChange,
    atomProject,
    setAtomProject,
  );
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [githubDialogOpen, setGithubDialogOpen] = useState(false);
  const [githubUrl, setGithubUrl] = useState('');

  // Refetch on every mount so Recent reflects chats created since the last new-chat screen.
  const { data: rawLocalProjects, isLoading: isLoadingProjects } = trpc.projects.list.useQuery(
    undefined,
    { refetchOnMount: 'always' },
  );

  // Guards: during tRPC client hydration on dev start (~1-2% of the time), data can
  // briefly be a non-undefined non-array value. See commit a6d57596.
  const localProjects = Array.isArray(rawLocalProjects) ? rawLocalProjects : undefined;

  const projects = useMemo(() => {
    if (!localProjects) return [];
    return localProjects.filter(isProjectSelectionCandidate);
  }, [localProjects]);

  // Filter projects by search query
  const filteredProjects = useMemo(() => {
    if (!projects) return [];
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query),
    );
  }, [projects, searchQuery]);

  // Get tRPC utils for cache management
  const utils = trpc.useUtils();

  // Every close path clears the search and refetches so Recent reflects new chats. Refetching on
  // open instead would reorder rows under the keyboard cursor.
  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      setView('list');
      return;
    }
    setSearchQuery('');
    void utils.projects.list.invalidate();
  };

  const setProjectSelection = useCallback(
    (project: ProjectSelectionCandidate) => {
      setSelectedProject({
        id: project.id,
        name: project.name,
        path: project.path,
        gitRemoteUrl: project.gitRemoteUrl ?? undefined,
        gitProvider: (project.gitProvider as 'github' | 'gitlab' | 'bitbucket' | null) ?? null,
        gitOwner: project.gitOwner ?? undefined,
        gitRepo: project.gitRepo ?? undefined,
      });
    },
    [setSelectedProject],
  );

  // Open folder mutation – refetch lists then auto-select so validSelection sees the new project
  const openFolder = trpc.projects.openFolder.useMutation({
    onSuccess: async (project) => {
      if (project) {
        await utils.projects.list.invalidate();
        if (isProjectSelectionCandidate(project)) {
          setProjectSelection(project);
        }
      }
    },
    onError: (error) => {
      toast.error('Failed to open folder picker', {
        description: error.message,
      });
    },
  });

  // Clone from GitHub mutation – refetch lists then auto-select so validSelection sees the new project
  const cloneFromGitHub = trpc.projects.cloneFromGitHub.useMutation({
    onSuccess: async (project) => {
      if (project) {
        await utils.projects.list.invalidate();
        if (isProjectSelectionCandidate(project)) {
          setProjectSelection(project);
        }
        setGithubDialogOpen(false);
        setGithubUrl('');
      }
    },
  });

  const handleOpenFolder = async () => {
    handleOpenChange(false);
    try {
      await openFolder.mutateAsync();
    } catch {
      // Error is surfaced in onError toast.
    }
  };

  const handleCloneFromGitHub = async () => {
    if (!githubUrl.trim()) return;
    await cloneFromGitHub.mutateAsync({ repoUrl: githubUrl.trim() });
  };

  const handleSelectProject = (projectId: string | null) => {
    if (projectId === null) {
      // Deselect - clear project selection
      setSelectedProject(null);
      handleOpenChange(false);
      return;
    }
    // Picking an existing project clears the general/new target (the project name shows instead).
    onNewChatTargetChange?.('unset');
    const project = projects?.find((p) => p.id === projectId);
    if (project) {
      setSelectedProject({
        id: project.id,
        name: project.name,
        path: project.path,
        gitRemoteUrl: project.gitRemoteUrl,
        gitProvider: project.gitProvider as 'github' | 'gitlab' | 'bitbucket' | null,
        gitOwner: project.gitOwner,
        gitRepo: project.gitRepo,
      });
      handleOpenChange(false);
    }
  };

  const validSelection = useMemo(
    () => validateProjectAgainstList(selectedProject, projects, isLoadingProjects),
    [selectedProject, projects, isLoadingProjects],
  );

  const triggerDisplayName = useMemo(() => {
    const fromValid = validSelection?.name?.trim();
    if (fromValid) return fromValid;
    const fromParent = displayNameFallback?.trim();
    if (fromParent) return fromParent;
    return '';
  }, [validSelection, displayNameFallback]);

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="flex gap-1.5 px-2 py-1 text-sm transition-[background-color,color] duration-150 ease-out rounded-md disabled:opacity-70"
            disabled={openFolder.isPending || cloneFromGitHub.isPending}
          >
            {openFolder.isPending || cloneFromGitHub.isPending ? (
              <>
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                <span className="truncate">Adding, this may take a moment...</span>
              </>
            ) : (
              <>
                <ProjectIcon
                  gitOwner={validSelection?.gitOwner}
                  gitProvider={validSelection?.gitProvider}
                  fallbackGitOwner={selectedProject?.gitOwner ?? displayNameFallbackGit?.gitOwner}
                  fallbackGitProvider={
                    selectedProject?.gitProvider ?? displayNameFallbackGit?.gitProvider
                  }
                  isBuild={isBuildProjectPath(validSelection?.path ?? selectedProject?.path)}
                />
                <span className="truncate max-w-[120px]">
                  {projectTriggerLabel(
                    triggerDisplayName,
                    isNewChatContext,
                    newChatTarget ?? 'unset',
                  )}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-80 p-0"
          align="start"
          onEscapeKeyDown={(event) => {
            if (view !== 'add') return;
            event.preventDefault();
            setView('list');
          }}
        >
          <PickerList
            searchQuery={searchQuery}
            onSearchQueryChange={(query) => {
              setSearchQuery(query);
              if (query) setView('list');
            }}
            view={view}
            onViewChange={setView}
            isLoadingProjects={isLoadingProjects}
            isNewChatContext={isNewChatContext}
            newChatTarget={newChatTarget}
            onNewChatTargetChange={onNewChatTargetChange}
            validSelection={validSelection}
            filteredProjects={filteredProjects}
            openFolderPending={openFolder.isPending}
            clonePending={cloneFromGitHub.isPending}
            onSelectProject={handleSelectProject}
            onSetSelectedProject={setSelectedProject}
            onClose={() => handleOpenChange(false)}
            onOpenFolder={handleOpenFolder}
            onOpenCloneDialog={() => {
              handleOpenChange(false);
              setGithubDialogOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>

      <GitHubCloneDialog
        open={githubDialogOpen}
        onOpenChange={setGithubDialogOpen}
        url={githubUrl}
        onUrlChange={setGithubUrl}
        onSubmit={handleCloneFromGitHub}
        isPending={cloneFromGitHub.isPending}
      />
    </>
  );
}
