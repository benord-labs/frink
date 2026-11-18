import { Badge, Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, ChevronRight, GitBranch, type LucideIcon, X } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Each role's tint. The label, or the icon that stands in for it, says the role too, so colour is
 *  never the only cue. */
const BADGE_TONES = {
  main: 'bg-foreground/5 text-muted-foreground',
  linked: 'bg-primary/10 text-primary',
};

/** Under this width (container `root-row`) a badge with an icon shows only the icon, which leaves
 *  the project's name more room. Screen readers still hear the label. */
const LABEL_HIDDEN_WHEN_NARROW = '@max-[15rem]/root-row:sr-only';

/** What a project is to its tree, e.g. "Linked"; `tone` tints it, neutral by default. `hint`
 *  says what the role means, in the row's tooltip. */
type RootBadgeProps = {
  label: string;
  icon?: LucideIcon;
  tone?: keyof typeof BADGE_TONES;
  hint?: string;
};

function RootBadge({
  label,
  icon: Icon,
  tone = 'main',
  iconOnlyWhenNarrow = false,
}: RootBadgeProps & { iconOnlyWhenNarrow?: boolean }): ReactElement {
  return (
    <Badge shape="tag" className={cn('shrink-0 gap-1 font-normal', BADGE_TONES[tone])}>
      {Icon && <Icon className="size-3" aria-hidden />}
      <span className={Icon && iconOnlyWhenNarrow ? LABEL_HIDDEN_WHEN_NARROW : undefined}>
        {label}
      </span>
    </Badge>
  );
}

/** A project's name and badge over its search results; its folder shows on hover. */
export function RootHeading({
  name,
  path,
  badge,
}: {
  name: string;
  path: string;
  badge: RootBadgeProps;
}): ReactElement {
  return (
    <h3
      title={path}
      className="flex min-w-0 items-center gap-1.5 px-1 pb-1 text-xs font-semibold text-foreground/85"
    >
      <span className="truncate">{name}</span>
      <RootBadge {...badge} />
    </h3>
  );
}

type Props = {
  name: string;
  /** The project's folder, shown in the row's tooltip */
  path: string;
  /** The folder's current branch; nothing shows without one */
  branch?: string | null;
  /** The folder is gone: a warning shows in place of the branch, open or closed */
  missing?: boolean;
  badge?: RootBadgeProps;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** The id of the element the row shows and hides */
  controlsId: string;
  /** Adds an x beside the row that takes the project out of the tree, e.g. by unlinking it */
  remove?: { label: string; onRemove: () => void };
};

/** The heading row of one project in a file tree, which shows and hides that project's files. */
export function ProjectRootRow({
  name,
  path,
  branch,
  missing = false,
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

  return (
    <div className="@container/root-row flex items-center gap-0.5 pr-1">
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-root-row
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
            {badge && <RootBadge {...badge} iconOnlyWhenNarrow />}
            {missing ? (
              <span className="flex shrink-0 items-center text-warning">
                <AlertTriangle className="size-3" aria-hidden />
                <span className="sr-only">folder missing</span>
              </span>
            ) : (
              branch && (
                // Shrinks a thousand times faster than the name, down to its icon, so a long branch
                // gives way first. The tooltip shows it whole.
                <span className="flex min-w-3 shrink-1000 items-center gap-1 font-normal text-muted-foreground">
                  <GitBranch className="size-3 shrink-0" aria-hidden />
                  <span className="sr-only">on branch</span>
                  <span className="truncate">{branch}</span>
                </span>
              )
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="wrap-anywhere">
          {/* Names the badge too, whose label a narrow row shows only as its icon */}
          <p className="font-medium">{badge ? `${name} · ${badge.label}` : name}</p>
          {!missing && branch && <p>{`On branch ${branch}`}</p>}
          {badge?.hint && <p>{badge.hint}</p>}
          {missing && <p>{`Can't find ${name}'s folder.`}</p>}
          <p className="font-mono">{path}</p>
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
