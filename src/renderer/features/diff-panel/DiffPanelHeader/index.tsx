import { Button } from '@benord-labs/frink-primitives';
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsRight,
  ChevronsUpDown,
  Columns2,
  GitBranch,
  Rows2,
} from 'lucide-react';
import { useAtom } from 'jotai';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePRStatus } from '@/hooks/usePRStatus';
import { diffPanelLayoutAtom } from '@/lib/atoms';
import { trpc } from '@/lib/trpc';
import { getPrHandoffState } from '@/lib/utils/diff/diff-code-view-items';
import { isAllowedShellOpenExternalUrl } from '../../../../shared/shell-external-url';

/** Git work the panel hands to the agent as a chat message; the panel never changes the repo. */
export type DiffHandoffs = {
  isBusy: boolean;
  onCommit: () => void;
  onCreatePr: () => void;
  onCommitToPr: () => void;
  onReview: () => void;
  onFixConflicts: () => void;
  onMerge: () => void;
};

type DiffPanelHeaderProps = {
  worktreePath: string;
  hasChanges: boolean;
  allCollapsed: boolean;
  onToggleAllCollapsed: () => void;
  onClose: () => void;
  handoffs?: DiffHandoffs;
};

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="xs" iconOnly aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

type PrMenuState = ReturnType<typeof getPrHandoffState>;

/** The PR-dependent items; they wait for a known PR status rather than guess there is none. */
function PrHandoffItems({
  handoffs,
  hasChanges,
  pr,
}: {
  handoffs: DiffHandoffs;
  hasChanges: boolean;
  pr: PrMenuState;
}) {
  if (!pr.isPrKnown) {
    return <DropdownMenuItem disabled>Checking for a pull request…</DropdownMenuItem>;
  }
  if (!pr.isPrOpen) {
    return <DropdownMenuItem onClick={handoffs.onCreatePr}>Create pull request</DropdownMenuItem>;
  }
  return (
    <>
      {hasChanges && (
        <DropdownMenuItem onClick={handoffs.onCommitToPr}>Commit and push to PR</DropdownMenuItem>
      )}
      {pr.hasMergeConflicts ? (
        <DropdownMenuItem onClick={handoffs.onFixConflicts}>Fix merge conflicts</DropdownMenuItem>
      ) : (
        <DropdownMenuItem onClick={handoffs.onMerge}>Merge pull request</DropdownMenuItem>
      )}
    </>
  );
}

type AskAgentMenuProps = { handoffs: DiffHandoffs; hasChanges: boolean; pr: PrMenuState };

function AskAgentMenu({ handoffs, hasChanges, pr }: AskAgentMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="xs" disabled={handoffs.isBusy} className="gap-1">
          Ask agent
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {hasChanges && (
          <DropdownMenuItem onClick={handoffs.onCommit}>Commit changes</DropdownMenuItem>
        )}
        <PrHandoffItems handoffs={handoffs} hasChanges={hasChanges} pr={pr} />
        <DropdownMenuItem onClick={handoffs.onReview}>Review changes</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DiffPanelHeader({
  worktreePath,
  hasChanges,
  allCollapsed,
  onToggleAllCollapsed,
  onClose,
  handoffs,
}: DiffPanelHeaderProps) {
  const {
    pr,
    isLoading: isPrLoading,
    isError: isPrError,
  } = usePRStatus({
    worktreePath,
    refetchInterval: 30_000,
  });
  const [layout, setLayout] = useAtom(diffPanelLayoutAtom);
  const { data: branches } = trpc.changes.getBranches.useQuery(
    { worktreePath },
    { staleTime: 30_000 },
  );

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/30 px-2">
      <IconButton label="Close changes" onClick={onClose}>
        <ChevronsRight className="size-4" />
      </IconButton>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate text-foreground">{branches?.current || 'No branch'}</span>
        {pr && isAllowedShellOpenExternalUrl(pr.url) && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded px-1 font-mono hover:bg-foreground/10"
          >
            #{pr.number}
          </a>
        )}
      </div>
      {hasChanges && (
        <>
          <IconButton
            label={layout === 'split' ? 'Show in one column' : 'Show side by side'}
            onClick={() => setLayout((prev) => (prev === 'split' ? 'unified' : 'split'))}
          >
            {layout === 'split' ? <Rows2 className="size-4" /> : <Columns2 className="size-4" />}
          </IconButton>
          <IconButton
            label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
            onClick={onToggleAllCollapsed}
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-4" />
            ) : (
              <ChevronsDownUp className="size-4" />
            )}
          </IconButton>
        </>
      )}
      {handoffs && (
        <AskAgentMenu
          handoffs={handoffs}
          hasChanges={hasChanges}
          pr={getPrHandoffState(pr, !isPrLoading && !isPrError)}
        />
      )}
    </div>
  );
}
