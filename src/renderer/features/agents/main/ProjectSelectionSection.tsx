import type { ReactElement, ReactNode } from 'react';
import { usePriorityOverflow } from '@/hooks/usePriorityOverflow';
import type { NewChatTarget } from '@/lib/agent-chat/new-chat-target';
import type { BranchListItem } from '../../../lib/branch-normalization';
import type { SelectedProject } from '../atoms';
import { BranchSelector } from '../components/branch-selector';
import { CreateBranchDialog } from '../components/create-branch-dialog';
import { WorkModeSelector } from '../components/work-mode-selector';
import { ProjectSelector } from '../ProjectSelector';
import {
  ContextOverflowMenu,
  type OverflowRow,
} from './active-chat/components/ContextOverflowMenu';
import { STRINGS } from './new-chat-form-constants';

/** Tailwind `gap-2`, which the overflow measurement has to account for. */
const GAP_PX = 8;

type Branch = BranchListItem;

type Project = {
  id: string;
  name: string;
  path: string;
  /** For repo icon when the selector list has not validated yet (see ProjectSelector). */
  gitOwner?: string | null;
  gitProvider?: NonNullable<SelectedProject>['gitProvider'];
};

type Props = {
  project: Project | null;
  /** When in split view, pass pane's project so ProjectSelector uses it instead of global atom */
  overrideProject?: SelectedProject | null;
  onOverrideProjectChange?: (project: SelectedProject | null) => void;
  /** Goal-first (sc-788): 'unset' (→ general chat on send) · 'general' · 'new' (→ scaffold). */
  newChatTarget?: NewChatTarget;
  onNewChatTargetChange?: (target: NewChatTarget) => void;
  workMode: 'local' | 'worktree';
  branches: Branch[];
  selectedBranch: string;
  selectedBranchType: 'local' | 'remote' | undefined;
  defaultBranch: string | undefined;
  isLoadingBranches: boolean;
  isCreatingChat: boolean;
  branchSearch: string;
  branchPopoverOpen: boolean;
  createBranchDialogOpen: boolean;
  onWorkModeChange: (mode: 'local' | 'worktree') => void;
  onBranchSelect: (branch: string, type?: 'local' | 'remote') => void;
  onBranchSearchChange: (search: string) => void;
  onBranchPopoverOpenChange: (open: boolean) => void;
  onCreateBranchDialogOpenChange: (open: boolean) => void;
  onBranchCreated: (branchName: string) => void;
  /** Local mode: git checkout branch picker (switch branch), rendered after WorkModeSelector */
  localBranchCheckoutPicker?: ReactNode;
};

/**
 * Project selection section with work mode and branch selectors. One row at every width: the
 * project is fixed, and the controls that no longer fit move behind an ellipsis, work mode first.
 */
export function ProjectSelectionSection({
  project,
  overrideProject,
  onOverrideProjectChange,
  newChatTarget,
  onNewChatTargetChange,
  workMode,
  branches,
  selectedBranch,
  selectedBranchType,
  defaultBranch,
  isLoadingBranches,
  isCreatingChat,
  branchSearch,
  branchPopoverOpen,
  createBranchDialogOpen,
  onWorkModeChange,
  onBranchSelect,
  onBranchSearchChange,
  onBranchPopoverOpenChange,
  onCreateBranchDialogOpenChange,
  onBranchCreated,
  localBranchCheckoutPicker,
}: Props): ReactElement {
  const items: OverflowRow[] = [];
  if (project) {
    items.push({
      key: 'mode',
      name: 'Mode',
      node: (
        <WorkModeSelector value={workMode} onChange={onWorkModeChange} disabled={isCreatingChat} />
      ),
    });
  }
  if (project && workMode === 'local' && localBranchCheckoutPicker) {
    items.push({ key: 'branch', name: 'Branch', node: localBranchCheckoutPicker });
  }
  if (project && workMode === 'worktree') {
    items.push({
      key: 'branch',
      name: 'Branch',
      node: (
        <BranchSelector
          branches={branches}
          selectedBranch={selectedBranch}
          selectedBranchType={selectedBranchType}
          defaultBranch={defaultBranch || STRINGS.BRANCH_DEFAULT}
          isLoading={isLoadingBranches}
          onBranchSelect={onBranchSelect}
          onCreateBranch={() => {
            onCreateBranchDialogOpenChange(true);
            onBranchPopoverOpenChange(false);
          }}
          isOpen={branchPopoverOpen}
          onOpenChange={onBranchPopoverOpenChange}
          searchQuery={branchSearch}
          onSearchChange={onBranchSearchChange}
        />
      ),
    });
  }

  // The key names what changes a hidden control's width or which control fills a slot.
  const { containerRef, moreRef, setItemRef, visibleFrom } = usePriorityOverflow(
    items.length,
    GAP_PX,
    JSON.stringify([project?.id, workMode, selectedBranch, Boolean(localBranchCheckoutPicker)]),
  );

  return (
    <>
      <div
        data-testid="project-selection-row"
        className="relative -mt-3.5 mx-3.5 flex min-w-0 items-center gap-2 overflow-hidden rounded-b-xl border border-t-0 border-border/60 bg-foreground/[0.02] px-1.5 pb-1.5 pt-5"
      >
        <div className="shrink-0 min-w-0">
          <ProjectSelector
            overrideProject={overrideProject}
            onOverrideProjectChange={onOverrideProjectChange}
            newChatTarget={newChatTarget}
            onNewChatTargetChange={onNewChatTargetChange}
            displayNameFallback={project?.name}
            displayNameFallbackGit={
              project
                ? {
                    gitOwner: project.gitOwner,
                    gitProvider: project.gitProvider,
                  }
                : null
            }
          />
        </div>

        <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-2">
          {items.slice(visibleFrom).map((item, index) => (
            <div
              key={item.key}
              ref={setItemRef(visibleFrom + index)}
              className="relative min-w-0 max-w-[14rem] shrink-0 before:absolute before:-left-1 before:top-1/2 before:h-3.5 before:w-px before:-translate-y-1/2 before:bg-border/60"
            >
              {item.node}
            </div>
          ))}
          {visibleFrom > 0 ? (
            <ContextOverflowMenu ref={moreRef} rows={items.slice(0, visibleFrom)} />
          ) : null}
        </div>
      </div>

      {project && (
        <CreateBranchDialog
          open={createBranchDialogOpen}
          onOpenChange={onCreateBranchDialogOpenChange}
          projectPath={project.path}
          branches={branches}
          defaultBranch={defaultBranch || STRINGS.BRANCH_DEFAULT}
          onBranchCreated={onBranchCreated}
        />
      )}
    </>
  );
}
