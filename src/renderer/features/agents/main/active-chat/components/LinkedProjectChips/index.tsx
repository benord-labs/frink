/**
 * The projects linked to a chat, as chips beside its project in the workspace row, then a chip that
 * links another. A link changes no folder or branch, so the chips stay usable while the chat runs or
 * its workspace is locked.
 */
import { Button } from '@benord-labs/frink-primitives';
import { AlertTriangle, Link, Plus, X } from 'lucide-react';
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { LinkProjectPicker } from '@/components/ProjectPicker/LinkProjectPicker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type TreeProjects, useTreeProjects } from '@/lib/workspace-context/use-tree-projects';
import { readLoadedChatTexts } from '../../../../stores/message-store';

/** Links are read on each of the agent's steps, and it is told about them with each message. */
const RUNNING_HINT =
  'The agent can read it from its next step and hears about it with your next message.';

/** Shown from this row width (container `workspace-row`) while the group has room for it. */
const LABEL_CLASS = 'hidden @min-[30rem]/workspace-row:inline';

/** What the group shows, most first. The row's overflow menu holds only the git controls, so the
 *  chips keep a cap of their own and step down while they don't fit, or while the git controls
 *  don't: the labels go first, then one chip at a time into the count, and last Link project,
 *  which the file tree also has. */
const FITS = [
  { inline: 2, labels: true, link: true },
  { inline: 2, labels: false, link: true },
  { inline: 1, labels: false, link: true },
  { inline: 0, labels: false, link: true },
  { inline: 0, labels: false, link: false },
] as const;

/** A chip's name keeps at least this much, about six letters, or all of a shorter name. */
const NAME_FLOOR_PX = 40;

type LinkedProject = TreeProjects['extras'][number];

/** What a link's tooltip says, line by line, ending with its folder. */
function statusLines({ name, path, missing }: LinkedProject, running: boolean): string[] {
  if (missing) return [`Can't find ${name}'s folder.`, path];
  return [`${name} is linked to this chat.`, ...(running ? [RUNNING_HINT] : []), path];
}

/** The chips run past the group, or squeeze a name below the floor. Widths are whole pixels, so a
 *  pixel of rounding is allowed for. */
function isCramped(group: HTMLElement): boolean {
  if (group.scrollWidth > group.clientWidth + 1) return true;
  return Array.from(group.querySelectorAll<HTMLElement>('[data-chip-name]')).some(
    (name) => name.clientWidth + 1 < Math.min(name.scrollWidth, NAME_FLOOR_PX),
  );
}

/**
 * The most the group can show. It starts from the most whenever the row resizes or `contentKey`
 * changes, then steps down before paint while the chips are cramped or the row is `crowded`. A
 * neighbour that squeezes the group, such as the cache timer showing up, steps it down too.
 */
function useFit(
  groupRef: RefObject<HTMLDivElement | null>,
  contentKey: string,
  crowded: () => boolean,
) {
  const [rowWidth, setRowWidth] = useState(0);
  const [fit, setFit] = useState({ key: '', step: 0 });
  const [, remeasure] = useReducer((count: number) => count + 1, 0);
  const key = `${rowWidth}|${contentKey}`;
  const step = fit.key === key ? fit.step : 0;

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (group && step < FITS.length - 1 && (isCramped(group) || crowded()))
      setFit({ key, step: step + 1 });
  });
  useLayoutEffect(() => {
    const group = groupRef.current;
    const row = group?.parentElement;
    if (!group || !row) return;
    setRowWidth(row.clientWidth);
    const observer = new ResizeObserver(() => {
      setRowWidth(row.clientWidth);
      if (isCramped(group)) remeasure();
    });
    observer.observe(row);
    observer.observe(group);
    return () => observer.disconnect();
  }, [groupRef]);

  return FITS[step];
}

type ChipProps = {
  project: LinkedProject;
  /** What the link's tooltip says; its x reads it out too */
  lines: string[];
  onUnlink: () => void;
};

/** The project's name between its link icon and its x, with a warning when its folder is gone. */
function ChipBody({ project, lines, onUnlink }: ChipProps) {
  const descriptionId = useId();
  return (
    <>
      <Link className="size-3 shrink-0 text-primary" aria-hidden />
      <span data-chip-name className="truncate">
        {project.name}
      </span>
      {project.missing && (
        <span className="flex shrink-0 text-warning">
          <AlertTriangle className="size-3" aria-hidden />
          <span className="sr-only">folder missing</span>
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        iconOnly
        shape="pill"
        aria-label={`Unlink ${project.name}`}
        aria-describedby={descriptionId}
        onClick={onUnlink}
        className="ml-auto size-4 shrink-0"
      >
        <X className="size-3" aria-hidden />
      </Button>
      <span id={descriptionId} className="sr-only">
        {lines.join(' ')}
      </span>
    </>
  );
}

function LinkedChip({ running, ...props }: Omit<ChipProps, 'lines'> & { running: boolean }) {
  const lines = statusLines(props.project, running);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Shrinks to its icons and x, never past them, so a long name truncates */}
        <span
          className={cn(
            'flex h-5 max-w-[10rem] items-center gap-1 rounded-full border border-primary/30 bg-primary/10 pr-0.5 pl-1.5 text-foreground',
            props.project.missing ? 'min-w-16' : 'min-w-12',
          )}
        >
          <ChipBody {...props} lines={lines} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="wrap-anywhere">
        {lines.map((line, index) => (
          <p key={line} className={cn(index === lines.length - 1 && 'font-mono')}>
            {line}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

type MoreLinkedProps = {
  projects: LinkedProject[];
  running: boolean;
  labelClass: string;
  /** `onError` runs when the link can't be removed */
  onUnlink: (projectId: string, onError: () => void) => void;
};

/** A count of the links past the cap, which lists them, each with its own x. */
function MoreLinked({ projects, running, labelClass, onUnlink }: MoreLinkedProps) {
  const listRef = useRef<HTMLUListElement>(null);
  // The row whose x was pressed: once it has gone, focus moves to the row now in its place, so the
  // list stays open for the next one.
  const unlinkedAt = useRef<number | null>(null);
  const ids = projects.map((project) => project.id).join('\n');
  useEffect(() => {
    const at = unlinkedAt.current;
    unlinkedAt.current = null;
    if (at === null || document.activeElement !== document.body) return;
    const unlinks = listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [];
    unlinks[Math.min(at, unlinks.length - 1)]?.focus();
  }, [ids]);

  const count = `+${projects.length}`;
  const missing = projects.some((project) => project.missing);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          shape="pill"
          aria-label={`${count} linked${missing ? ', folder missing' : ''}`}
          className="h-5 shrink-0 gap-0 px-1.5"
        >
          {count}
          <span className={labelClass}>&nbsp;linked</span>
          {missing && <AlertTriangle className="ml-1 size-3 text-warning" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-56 px-1">
        <ul ref={listRef} aria-label="More linked projects" className="text-xs">
          {projects.map((project, index) => {
            const lines = statusLines(project, running);
            const unlink = () => {
              unlinkedAt.current = index;
              onUnlink(project.id, () => {
                unlinkedAt.current = null;
              });
            };
            return (
              <li key={project.id} title={lines.join('\n')} className="px-2 py-1">
                <div className="flex items-center gap-1.5">
                  <ChipBody project={project} lines={lines} onUnlink={unlink} />
                </div>
                {/* Its x reads all of this out already */}
                <p
                  aria-hidden
                  className={cn(
                    'truncate',
                    project.missing ? 'text-warning' : 'font-mono text-muted-foreground',
                  )}
                >
                  {project.missing ? lines[0] : project.path}
                </p>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

type Props = {
  chatId: string;
  /** The chat's agent is at work: the tooltips then say when a change reaches it */
  running?: boolean;
  /** The controls after the group don't all fit, read from the layout as it is now: the group
   *  steps down for them before any of them hides */
  crowded?: () => boolean;
  /** Changes with those controls, so the group starts again from the most */
  crowdKey?: string;
  /** How many of those controls are hidden now. Read nowhere: a change only renders the group
   *  again, so it asks `crowded` again without starting over. The controls measure only after the
   *  group first lays out, and a memoized row re-renders nothing else here then. */
  hiddenCount?: number;
};

type GroupProps = Required<Props> & Pick<TreeProjects, 'extras' | 'remove'>;

const NEVER_CROWDED = () => false;

/** At most 40% of the row, and less while the git controls need its room. */
function ChipsGroup({ chatId, running, crowded, crowdKey, extras, remove }: GroupProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLButtonElement>(null);
  const fit = useFit(groupRef, `${JSON.stringify(extras)}|${crowdKey}`, crowded);
  // Set by an x, so focus moves on once its chip has gone and taken focus with it.
  const refocus = useRef(false);
  const linkedIds = extras.map((project) => project.id).join('\n');
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body) linkRef.current?.focus();
  }, [linkedIds]);

  const unlink = (projectId: string, onError?: () => void) => {
    refocus.current = true;
    remove(projectId, {
      onError: () => {
        refocus.current = false;
        onError?.();
      },
    });
  };
  const labelClass = fit.labels ? LABEL_CLASS : 'hidden';
  return (
    <div
      ref={groupRef}
      role="group"
      aria-label="Linked projects"
      className="flex min-w-0 max-w-[40%] items-center gap-x-1.5"
    >
      {extras.slice(0, fit.inline).map((project) => (
        <LinkedChip
          key={project.id}
          project={project}
          running={running}
          onUnlink={() => unlink(project.id)}
        />
      ))}
      {extras.length > fit.inline && (
        <MoreLinked
          projects={extras.slice(fit.inline)}
          running={running}
          labelClass={labelClass}
          onUnlink={unlink}
        />
      )}
      <LinkProjectPicker
        chatId={chatId}
        getMentionTexts={() => readLoadedChatTexts(chatId)}
        tooltip={
          running ? (
            <>
              <p>Link another project to this chat</p>
              <p>{RUNNING_HINT}</p>
            </>
          ) : undefined
        }
        trigger={
          <Button
            ref={linkRef}
            variant="ghost"
            size="xs"
            shape="pill"
            aria-label="Link project"
            className={cn(
              'h-5 shrink-0 gap-1 border border-dashed border-border px-1.5',
              // Hidden rather than gone, so a picker opened from it stays open
              !fit.link && 'hidden',
            )}
          >
            <Plus className="size-3" aria-hidden />
            <span className={labelClass}>Link project</span>
          </Button>
        }
      />
    </div>
  );
}

/** Nothing shows for a chat without a project folder of its own, which can't link projects. */
export function LinkedProjectChips({
  chatId,
  running = false,
  crowded = NEVER_CROWDED,
  crowdKey = '',
  hiddenCount = 0,
}: Props): ReactElement | null {
  const { extras, canAdd, remove } = useTreeProjects(chatId);
  if (!canAdd) return null;
  return (
    <ChipsGroup
      chatId={chatId}
      running={running}
      crowded={crowded}
      crowdKey={crowdKey}
      hiddenCount={hiddenCount}
      extras={extras}
      remove={remove}
    />
  );
}
