import githubLogo from '@iconify-icons/simple-icons/github';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { Button } from '@benord-labs/frink-primitives';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { NewChatTarget } from '@/lib/agent-chat/new-chat-target';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../../components/ui/command';
import { isBuildProjectPath } from '../../../../lib/build-project';
import type { SelectedProject } from '../../atoms';
import { formatTimeAgo } from '../../utils/format-time-ago';
import { ProjectIcon } from '../ProjectIcon';
import type { ProjectSelectionCandidate } from '../types';

const GitHubIcon = iconifyComponent(githubLogo);

export type PickerView = 'list' | 'add';

// One button for both picker footer actions. `pendingLabel` is optional: Clone swaps its
// label while cloning; Open-folder keeps its label (only the icon becomes a spinner).
function PickerActionButton({
  icon,
  label,
  pendingLabel,
  onClick,
  isPending,
}: {
  icon: ReactNode;
  label: string;
  pendingLabel?: string;
  onClick: () => void;
  isPending: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={isPending}
      className="flex gap-1.5 min-h-[32px] h-auto py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm justify-start cursor-default dark:hover:bg-neutral-800 hover:text-foreground disabled:opacity-60"
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 text-muted-foreground shrink-0 animate-spin" />
      ) : (
        icon
      )}
      <span>{isPending && pendingLabel ? pendingLabel : label}</span>
    </Button>
  );
}

function AddProjectOption({
  value,
  icon,
  label,
  description,
  onSelect,
}: {
  value: string;
  icon: ReactNode;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect} className="gap-2 items-start">
      {icon}
      <div className="flex flex-1 flex-col min-w-0">
        <span className="wrap-break-word">{label}</span>
        <span className="wrap-break-word text-xs text-muted-foreground">{description}</span>
      </div>
    </CommandItem>
  );
}

type PickerListProps = {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  view: PickerView;
  onViewChange: (view: PickerView) => void;
  isLoadingProjects: boolean;
  isNewChatContext: boolean;
  newChatTarget?: NewChatTarget;
  onNewChatTargetChange?: (target: NewChatTarget) => void;
  validSelection: SelectedProject | null;
  filteredProjects: ProjectSelectionCandidate[];
  openFolderPending: boolean;
  clonePending: boolean;
  onSelectProject: (projectId: string | null) => void;
  onSetSelectedProject: (project: SelectedProject | null) => void;
  onClose: () => void;
  onOpenFolder: () => void;
  onOpenCloneDialog: () => void;
};

export function PickerList({
  searchQuery,
  onSearchQueryChange,
  view,
  onViewChange,
  isLoadingProjects,
  isNewChatContext,
  newChatTarget,
  onNewChatTargetChange,
  validSelection,
  filteredProjects,
  openFolderPending,
  clonePending,
  onSelectProject,
  onSetSelectedProject,
  onClose,
  onOpenFolder,
  onOpenCloneDialog,
}: PickerListProps) {
  const showNewChatRows = isNewChatContext && !searchQuery.trim();
  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder="Search projects..."
        value={searchQuery}
        onValueChange={onSearchQueryChange}
      />
      <CommandList className="max-h-[320px] overflow-y-auto">
        {isLoadingProjects ? (
          <div className="px-2.5 py-4 text-center text-sm text-muted-foreground">Loading...</div>
        ) : view === 'add' ? (
          <CommandGroup>
            <CommandItem
              value="add-project-back"
              onSelect={() => onViewChange('list')}
              className="gap-2"
            >
              <ChevronLeft className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">Add project</span>
            </CommandItem>
            <AddProjectOption
              value="add-project-scratch"
              icon={<Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />}
              label="Start from scratch"
              description="Frink makes a new folder for you"
              onSelect={() => {
                onNewChatTargetChange?.('new');
                onSetSelectedProject(null);
                onClose();
              }}
            />
            <AddProjectOption
              value="add-project-folder"
              icon={
                openFolderPending ? (
                  <Loader2 className="h-4 w-4 text-muted-foreground shrink-0 animate-spin" />
                ) : (
                  <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                )
              }
              label="Open a folder"
              description="Use a folder already on your computer"
              onSelect={onOpenFolder}
            />
            <AddProjectOption
              value="add-project-clone"
              icon={
                clonePending ? (
                  <Loader2 className="h-4 w-4 text-muted-foreground shrink-0 animate-spin" />
                ) : (
                  <GitHubIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                )
              }
              label="Clone from GitHub"
              description="Copy a project from GitHub"
              onSelect={onOpenCloneDialog}
            />
          </CommandGroup>
        ) : (
          <>
            {showNewChatRows && (
              <CommandGroup>
                <CommandItem
                  value="general-chat"
                  onSelect={() => {
                    onNewChatTargetChange?.('general');
                    onSetSelectedProject(null);
                    onClose();
                  }}
                  className="gap-2"
                >
                  <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 wrap-break-word">General chat</span>
                  {!validSelection && newChatTarget === 'general' ? (
                    <Check className="h-4 w-4 shrink-0" />
                  ) : (
                    <span className="text-xs text-muted-foreground">No project</span>
                  )}
                </CommandItem>
              </CommandGroup>
            )}
            {filteredProjects.length > 0 ? (
              <CommandGroup heading="Recent">
                {filteredProjects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`${project.name} ${project.path}`}
                    onSelect={() => onSelectProject(project.id)}
                    className="gap-2 min-w-0"
                  >
                    <ProjectIcon
                      gitOwner={project.gitOwner}
                      gitProvider={project.gitProvider}
                      isBuild={isBuildProjectPath(project.path)}
                    />
                    <span className="flex-1 min-w-0 truncate" title={project.name}>
                      {project.name}
                    </span>
                    {project.lastActiveAt && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatTimeAgo(project.lastActiveAt)}
                      </span>
                    )}
                    {validSelection?.id === project.id && <Check className="h-4 w-4 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : searchQuery.trim() ? (
              <CommandEmpty>No projects found.</CommandEmpty>
            ) : null}
          </>
        )}
      </CommandList>
      {showNewChatRows && view === 'list' && !isLoadingProjects && (
        <CommandGroup className="border-t border-border/50">
          <CommandItem value="add-project" onSelect={() => onViewChange('add')} className="gap-2">
            <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex-1">Add project</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          </CommandItem>
        </CommandGroup>
      )}
      {/* Flow callers have no General chat / Add project rows; they keep these footer actions. */}
      {!isNewChatContext && (
        <div className="border-t border-border/50 py-1">
          <PickerActionButton
            icon={<FolderPlus className="h-4 w-4 text-muted-foreground" />}
            label="Open existing folder"
            onClick={onOpenFolder}
            isPending={openFolderPending}
          />
          <PickerActionButton
            icon={<GitHubIcon className="h-4 w-4 text-muted-foreground" />}
            label="Clone from GitHub"
            pendingLabel="Cloning, this may take a moment..."
            onClick={onOpenCloneDialog}
            isPending={clonePending}
          />
        </div>
      )}
    </Command>
  );
}
