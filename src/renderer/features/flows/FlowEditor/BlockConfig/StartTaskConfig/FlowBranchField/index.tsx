/**
 * Branch-from field for Start Task worktree: pick a repo branch or enter a template expression.
 * Uses BranchSelector (variant="field") to avoid duplicating the branch picker UI.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { GitBranch } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../../components/ui/tooltip';
import { transformBranchData } from '../../../../../../lib/branch-normalization';
import { trpc } from '../../../../../../lib/trpc';
import { BranchSelector } from '../../../../../agents/components/branch-selector';
import { LIMITS } from '../../../../../agents/main/new-chat-form-constants';
import { isProjectRow } from '../../shared';
import { FLOW_BRANCH_ICON_BUTTON } from './constants';

type Props = {
  effectiveProjectId: string | undefined;
  branch: string;
  onBranchChange: (branch: string | undefined) => void;
  htmlFor: string;
};

function hasTemplateSyntax(value: string): boolean {
  return value.includes('{{');
}

export function FlowBranchField({
  effectiveProjectId,
  branch,
  onBranchChange,
  htmlFor,
}: Props): ReactElement {
  const { data: allProjects, isLoading: projectsLoading } = trpc.projects.list.useQuery();

  const projectPath = useMemo((): string => {
    const id = (effectiveProjectId ?? '').trim();
    if (!id) return '';
    const list = Array.isArray(allProjects) ? allProjects : [];
    const found = list.find((p) => isProjectRow(p) && p.id === id);
    return found && isProjectRow(found) ? found.path : '';
  }, [effectiveProjectId, allProjects]);

  const branchesQuery = trpc.changes.getBranches.useQuery(
    { worktreePath: projectPath },
    {
      enabled: projectPath.length > 0,
      staleTime: LIMITS.BRANCHES_STALE_TIME_MS,
    },
  );

  const branches = useMemo(
    () => (branchesQuery.data ? transformBranchData(branchesQuery.data) : []),
    [branchesQuery.data],
  );

  const template = hasTemplateSyntax(branch);
  const [expressionMode, setExpressionMode] = useState(template);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (template) setExpressionMode(true);
  }, [template]);

  const showPicker = projectPath.length > 0 && !expressionMode;
  const effectiveId = (effectiveProjectId ?? '').trim();

  if (!effectiveId) {
    return (
      <div className="space-y-1.5">
        <Input
          id={htmlFor}
          value={branch}
          onChange={(e) => {
            const v = e.target.value.trim();
            onBranchChange(v.length > 0 ? v : undefined);
          }}
          placeholder="{{loop.currentItem.headRefName}}"
        />
        <p className="text-xs text-[hsl(var(--foreground-secondary))]">
          Select a project above to pick a branch from the list, or type a template expression.
        </p>
      </div>
    );
  }

  if (projectsLoading) {
    return (
      <Input
        id={htmlFor}
        value={branch}
        onChange={(e) => {
          const raw = e.target.value;
          const trimmed = raw.trim();
          onBranchChange(trimmed.length > 0 ? trimmed : undefined);
        }}
        placeholder="{{loop.currentItem.headRefName}}"
        aria-busy="true"
      />
    );
  }

  if (!projectPath) {
    return (
      <div className="space-y-1.5">
        <Input
          id={htmlFor}
          value={branch}
          onChange={(e) => {
            const v = e.target.value.trim();
            onBranchChange(v.length > 0 ? v : undefined);
          }}
          placeholder="{{loop.currentItem.headRefName}}"
        />
        <p className="text-xs text-[hsl(var(--foreground-secondary))]">
          Project path not found. Enter a branch name or template expression.
        </p>
      </div>
    );
  }

  if (showPicker) {
    return (
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <BranchSelector
            id={htmlFor}
            variant="field"
            branches={branches}
            selectedBranch={branch}
            selectedBranchType={undefined}
            defaultBranch=""
            isLoading={branchesQuery.isLoading}
            onBranchSelect={(name) => onBranchChange(name)}
            onSelectDefault={() => onBranchChange(undefined)}
            isOpen={popoverOpen}
            onOpenChange={setPopoverOpen}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
        </div>
        <Tooltip delayDuration={LIMITS.TOOLTIP_DELAY_MS}>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className={FLOW_BRANCH_ICON_BUTTON}
              aria-label="Use template expression"
              onClick={() => {
                setPopoverOpen(false);
                setExpressionMode(true);
              }}
              iconOnly
            >
              <span className="font-mono text-[11px] leading-none">{'{}'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Use template expression (e.g. loop variables)</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={htmlFor}
        value={branch}
        onChange={(e) => {
          const raw = e.target.value;
          const trimmed = raw.trim();
          onBranchChange(trimmed.length > 0 ? trimmed : undefined);
        }}
        placeholder="{{loop.currentItem.headRefName}}"
        className="min-w-0 flex-1"
      />
      <Tooltip delayDuration={LIMITS.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              variant="secondary"
              size="sm"
              className={FLOW_BRANCH_ICON_BUTTON}
              aria-label="Pick branch from list"
              disabled={template}
              onClick={() => setExpressionMode(false)}
              iconOnly
            >
              <GitBranch aria-hidden />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {template
            ? 'Remove {{ }} from the value to use the branch list'
            : 'Pick branch from list'}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
