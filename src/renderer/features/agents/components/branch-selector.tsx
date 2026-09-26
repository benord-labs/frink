/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { Plus, Trash2, GitBranch, Check, ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import { LeafLabel } from '../../../components/ui/leaf-label';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { VirtualSearchList } from '../../../components/ui/virtual-search-list';
import type { BranchListItem } from '../../../lib/branch-normalization';
import { createHighlightMatcher } from '../../../lib/highlight-match';
import { cn } from '../../../lib/utils';
import { LIMITS, STRINGS } from '../main/new-chat-form-constants';
import { formatTimeAgo } from '../utils/format-time-ago';

type Branch = BranchListItem;

export type BranchSelectorProps = {
  branches: Branch[];
  selectedBranch: string;
  selectedBranchType: 'local' | 'remote' | undefined;
  defaultBranch: string;
  isLoading: boolean;
  onBranchSelect: (branch: string, type: 'local' | 'remote') => void;
  /** When omitted the "+ Create" button is hidden. */
  onCreateBranch?: () => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onDeleteBranch?: (branch: string) => void;
  isBranchDeletable?: (branch: Branch) => boolean;
  /**
   * `chip` (default) — compact inline pill trigger used in the new-chat bar.
   * `field` — full-width form-field trigger that matches SelectTrigger in block configs.
   */
  variant?: 'chip' | 'field';
  /**
   * When provided, a "Default branch" row is rendered at the top of the list.
   * Selected when `selectedBranch` is empty.
   */
  onSelectDefault?: () => void;
  /** Associates the field-variant trigger with an external label (`htmlFor`). */
  id?: string;
  /** Override the search input placeholder. Defaults to "Search branches..." */
  searchPlaceholder?: string;
  /** Whether to show the local/remote type badge on each row. Defaults to true. */
  showTypeBadge?: boolean;
  /** Icon component rendered in the chip/field trigger. Defaults to GitBranch. */
  // biome-ignore lint/style/useNamingConvention: component type prop
  TriggerIcon?: React.ComponentType<{ className?: string }>;
};

/**
 * Branch selector with search and virtualized list
 */
export function BranchSelector({
  branches,
  selectedBranch,
  selectedBranchType,
  defaultBranch,
  isLoading,
  onBranchSelect,
  onCreateBranch,
  isOpen,
  onOpenChange,
  searchQuery,
  onSearchChange,
  onDeleteBranch,
  isBranchDeletable,
  variant = 'chip',
  onSelectDefault,
  id,
  searchPlaceholder,
  showTypeBadge = true,
  TriggerIcon = GitBranch,
}: BranchSelectorProps) {
  // Filter branches based on search
  const filteredBranches = searchQuery.trim()
    ? branches.filter((b) => b.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : branches;

  const highlight = useMemo(() => createHighlightMatcher(searchQuery), [searchQuery]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onSearchChange('');
    }
    onOpenChange(open);
  };

  const handleBranchClick = (branch: Branch) => {
    onBranchSelect(branch.name, branch.type);
    onOpenChange(false);
    onSearchChange('');
  };

  const handleCreateClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCreateBranch?.();
    onOpenChange(false);
  };

  const triggerLabel =
    onSelectDefault && selectedBranch.trim() === ''
      ? 'Default branch'
      : selectedBranch || defaultBranch || STRINGS.BRANCH_DEFAULT;

  const popoverContent = (
    <PopoverContent className="w-80 p-0" align="start">
      {/* Optional "Default branch" row */}
      {onSelectDefault && (
        <div className="border-b border-border px-1 py-0.5">
          <Button
            variant="ghost"
            size="auto"
            role="option"
            aria-selected={!selectedBranch}
            onClick={() => {
              onSelectDefault();
              onOpenChange(false);
              onSearchChange('');
            }}
            className={cn(
              'w-full justify-start text-left font-normal',
              'flex gap-2 rounded-md px-2 py-1.5 text-sm',
              !selectedBranch ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
            )}
          >
            <span className="min-w-0 flex-1 truncate">Default branch</span>
            {!selectedBranch && <Check className="h-4 w-4 shrink-0" aria-hidden />}
          </Button>
        </div>
      )}

      {/* Search row + virtualized branch list */}
      <VirtualSearchList
        items={filteredBranches}
        itemKey={(branch) => `${branch.type}-${branch.name}`}
        rowHeight={LIMITS.BRANCH_ITEM_HEIGHT}
        maxHeight={LIMITS.BRANCH_LIST_MAX_HEIGHT}
        overscan={LIMITS.BRANCH_LIST_OVERSCAN}
        open={isOpen}
        query={searchQuery}
        onQueryChange={onSearchChange}
        searchPlaceholder={searchPlaceholder ?? STRINGS.BRANCH_SEARCH_PLACEHOLDER}
        searchLabel="Search branches"
        listLabel="Branches"
        emptyText={STRINGS.BRANCH_NO_BRANCHES}
        searchAdornment={
          onCreateBranch && (
            <Button
              size="xs"
              variant="ghost"
              className="px-1.5 flex gap-1 shrink-0"
              onClick={handleCreateClick}
            >
              <Plus className="h-3 w-3" />
              {STRINGS.BUTTON_CREATE}
            </Button>
          )
        }
        renderRow={(branch) => {
          const typeMatches =
            selectedBranchType === undefined || selectedBranchType === branch.type;
          const isSelected =
            (selectedBranch === branch.name && typeMatches) ||
            (!selectedBranch && branch.isDefault && branch.type === 'local');
          const canDelete = Boolean(onDeleteBranch && isBranchDeletable?.(branch));

          return (
            <div
              className={cn(
                'flex h-full items-center gap-1.5 rounded-md px-1.5 text-sm select-none transition-colors',
                isSelected
                  ? 'bg-primary/10 text-foreground'
                  : 'hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Button
                variant="ghost"
                size="auto"
                role="option"
                aria-selected={isSelected}
                aria-label={branch.name}
                onClick={() => handleBranchClick(branch)}
                className="w-full justify-start text-left font-normal flex min-w-0 flex-1 gap-1.5 rounded-md py-0.5 px-0 hover:bg-transparent"
              >
                <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate flex-1 min-w-0">{highlight(branch.name)}</span>
                {showTypeBadge && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      branch.type === 'local'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-secondary text-secondary-foreground',
                    )}
                  >
                    {branch.type}
                  </span>
                )}
                {branch.committedAt ? (
                  <span className="shrink-0 text-xs text-[hsl(var(--foreground-secondary))]">
                    {formatTimeAgo(branch.committedAt)}
                  </span>
                ) : null}
                {branch.isDefault ? (
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-[hsl(var(--foreground-secondary))]">
                    {STRINGS.BRANCH_TAG_DEFAULT}
                  </span>
                ) : null}
                {isSelected && <Check className="h-4 w-4 shrink-0 ml-auto" />}
              </Button>
              {canDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                  title={`Delete ${branch.name}`}
                  aria-label={`Delete ${branch.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onDeleteBranch?.(branch.name);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        }}
      />
    </PopoverContent>
  );

  if (variant === 'field') {
    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="secondary"
            className={cn(
              'flex h-9 w-full justify-between gap-2 rounded-[10px] px-3 py-2 text-start text-sm text-foreground',
            )}
            disabled={isLoading}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <TriggerIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-left">{triggerLabel}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/80" aria-hidden />
          </Button>
        </PopoverTrigger>
        {popoverContent}
      </Popover>
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={LIMITS.TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'flex h-6 gap-1.5 rounded-md px-1.5 text-xs transition-[background-color,color] duration-150 ease-out min-w-0 max-w-full',
              )}
              disabled={isLoading}
            >
              <TriggerIcon className="h-3 w-3 shrink-0" />
              <LeafLabel text={triggerLabel} />
              <ChevronDown className="w-3 h-3 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{triggerLabel}</TooltipContent>
      </Tooltip>
      {popoverContent}
    </Popover>
  );
}
