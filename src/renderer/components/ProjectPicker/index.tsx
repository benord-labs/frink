import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { isBuildProjectPath } from '../../lib/build-project';
import { ProjectIcon } from '../ProjectIcon';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

type PickerProject = {
  id: string;
  name: string;
  path: string;
  gitOwner?: string | null;
  gitProvider?: string | null;
};

type Props = {
  /** The button that opens the picker; focus returns to it once the picker closes */
  trigger: ReactElement;
  /** Shown beside the trigger on hover and focus */
  tooltip?: ReactNode;
  /** The projects to choose from, in the order they are listed */
  candidates: PickerProject[];
  /** Names of projects shown elsewhere, such as those already in the tree; a candidate sharing
   *  one shows its parent folder too */
  takenNames?: string[];
  /** Candidates the chat mentions: listed before the others that match as well, with a hint */
  mentionedIds?: string[];
  /** Called as the picker opens and closes */
  onOpenChange?: (open: boolean) => void;
  /** Whether the list of projects is still loading or failed, rather than empty */
  status?: 'pending' | 'error' | 'success';
  /** A note below the list */
  footer: ReactNode;
  onPick: (projectId: string) => void;
};

/** The parent folder of each project whose name another project shares, to tell them apart. */
function parentFolders(projects: PickerProject[], takenNames: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const name of [...takenNames, ...projects.map((project) => project.name)]) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    projects
      .filter((project) => (counts.get(project.name) ?? 0) > 1)
      .map((project) => [project.id, project.path.split(/[\\/]/).filter(Boolean).at(-2) ?? '']),
  );
}

/** How well a project matches the search: the start of its name, then anywhere in its name, then
 *  only in its folder. Null when it doesn't match. */
function matchRank(project: PickerProject, needle: string): number | null {
  const name = project.name.toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  return project.path.toLowerCase().includes(needle) ? 2 : null;
}

/** The projects matching the search, best matches first, mentioned ones first among equally good
 *  matches, and otherwise in the given order. With no search, all match equally well. */
function matching(projects: PickerProject[], needle: string, mentioned: string[]): PickerProject[] {
  return projects
    .flatMap((project) => {
      const rank = matchRank(project, needle);
      if (rank === null) return [];
      return [{ project, rank: rank * 2 + (mentioned.includes(project.id) ? 0 : 1) }];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ project }) => project);
}

/** A list still loading or failed only matters while there is nothing to show. */
function emptyText(status: Props['status'], total: number, query: string): string {
  if (total > 0) return `No projects match “${query}”.`;
  if (status === 'pending') return 'Loading projects…';
  if (status === 'error') return "Can't load your projects.";
  return 'No other projects to add.';
}

/** A searchable list of projects in a popover. Picking one closes it. */
export function ProjectPicker({
  trigger,
  tooltip,
  candidates,
  takenNames = [],
  mentionedIds = [],
  onOpenChange,
  status = 'success',
  footer,
  onPick,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = matching(candidates, needle, mentionedIds);
  const parents = parentFolders(candidates, takenNames);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
    onOpenChange?.(next);
  };

  const button = <PopoverTrigger asChild>{trigger}</PopoverTrigger>;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {tooltip ? (
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      <PopoverContent className="w-72 p-0" align="end">
        <Command shouldFilter={false} aria-label="Projects">
          <CommandInput
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {shown.length === 0 ? (
              <CommandEmpty role="status">
                {emptyText(status, candidates.length, query.trim())}
              </CommandEmpty>
            ) : (
              shown.map((project) => {
                const parent = parents.get(project.id);
                return (
                  <CommandItem
                    key={project.id}
                    // The Command keeps a row selected while it stays listed; tying the value to
                    // the search selects the best match again after each keystroke, for Enter.
                    value={`${needle}:${project.id}`}
                    title={project.path}
                    onSelect={() => {
                      handleOpenChange(false);
                      onPick(project.id);
                    }}
                    className="min-w-0 gap-2"
                  >
                    <ProjectIcon
                      gitOwner={project.gitOwner}
                      gitProvider={project.gitProvider}
                      isBuild={isBuildProjectPath(project.path)}
                    />
                    {/* The hint sits under the name, so the name keeps the row's width */}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{project.name}</span>
                      {mentionedIds.includes(project.id) && (
                        <span className="truncate text-xs text-muted-foreground">
                          Mentioned in this chat
                        </span>
                      )}
                    </div>
                    {parent && (
                      <span className="shrink-0 text-xs text-muted-foreground">{parent}</span>
                    )}
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
        <p
          role="note"
          className="border-t border-border/50 px-2.5 py-2 text-xs leading-snug text-muted-foreground"
        >
          {footer}
        </p>
      </PopoverContent>
    </Popover>
  );
}
