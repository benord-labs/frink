import { Badge, Button } from '@benord-labs/frink-primitives';
import { ChevronRight, GitBranch, type LucideIcon, X } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Each role's tint. The label always says the role too, so colour is never the only cue. */
const BADGE_TONES = {
  main: 'bg-foreground/5 text-muted-foreground',
  browse: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  linked: 'bg-primary/10 text-primary',
};

type Props = {
  name: string;
  /** The project's folder, shown in the row's tooltip */
  path: string;
  /** The folder's current branch; nothing shows without one */
  branch?: string | null;
  /** What the project is to this tree, e.g. "Browsing"; `tone` tints it, neutral by default */
  badge?: { label: string; icon?: LucideIcon; tone?: keyof typeof BADGE_TONES };
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** The id of the element the row shows and hides */
  controlsId: string;
  /** Adds an x beside the row that takes the project out of the tree */
  remove?: { label: string; onRemove: () => void };
};

/** The heading row of one project in a file tree, which shows and hides that project's files. */
export function ProjectRootRow({
  name,
  path,
  branch,
  badge,
  expanded,
  onExpandedChange,
  controlsId,
  remove,
}: Props): ReactElement {
  // Right opens and Left closes, as on a folder row; Enter and Space toggle like any button.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = event.key === 'ArrowRight';
    if (next !== expanded) onExpandedChange(next);
  };
  const BadgeIcon = badge?.icon;

  return (
    <div className="flex items-center gap-0.5 pr-1">
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={controlsId}
            onClick={() => onExpandedChange(!expanded)}
            onKeyDown={handleKeyDown}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-semibold',
              'text-foreground/85 hover:bg-foreground/5 hover:text-foreground',
              'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
            )}
          >
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                expanded && 'rotate-90',
              )}
              aria-hidden
            />
            <span className="truncate">{name}</span>
            {badge && (
              <Badge
                shape="tag"
                className={cn('shrink-0 gap-1 font-normal', BADGE_TONES[badge.tone ?? 'main'])}
              >
                {BadgeIcon && <BadgeIcon className="size-3" aria-hidden />}
                {badge.label}
              </Badge>
            )}
            {branch && (
              <span className="flex min-w-0 items-center gap-1 font-normal text-muted-foreground">
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="sr-only">on branch</span>
                <span className="truncate">{branch}</span>
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono wrap-anywhere">
          {path}
        </TooltipContent>
      </Tooltip>
      {remove && (
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={remove.label}
              onClick={remove.onRemove}
              className="size-6 shrink-0"
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{remove.label}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
