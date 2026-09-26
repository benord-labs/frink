/** The Plugins directory's row language for every Agent setup list:
 * calm two-line rows that open in place, and a ⋯ menu that fades in without shifting. */
import { Button, cn, Input } from '@benord-labs/frink-primitives';
import { ChevronDown, MoreHorizontal, Search } from 'lucide-react';
import {
  type ComponentType,
  Fragment,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Secondary action built on `ghost`: the house `secondary` rim never paints (sc-3706). */
export function SoftButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="bg-foreground/[0.07] text-ink hover:bg-foreground/[0.11]"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Amber that stays readable on both themes, for states the user can fix. */
export const WARNING_TEXT_CLASS = 'text-[hsl(var(--status-warning-foreground))]';

export function SettingsList({ children }: { children: ReactNode }): ReactElement {
  return <ul className="border-hairline border-t">{children}</ul>;
}

/** Rows an open group shows before "Show N more", so one big group never becomes the whole page. */
const FOLD_GROUP_CAP = 10;

type FoldGroupProps<T> = {
  title: string;
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  defaultOpen: boolean;
  /** While searching: held open so every group's matches show (still capped). */
  forceOpen?: boolean;
  /** Never hide rows behind "Show N more" (a group whose every row needs the user). */
  uncapped?: boolean;
  /** The opened row's key: a row that moves into this group (turned off, fixed) is shown, not buried. */
  revealKey?: string | null;
  /** Sits at the end of the heading, e.g. a hand-off to where these items are managed. */
  action?: ReactNode;
  /** Lays the rows out differently, e.g. the plugin directory's two-column grid. */
  listClassName?: string;
};

/** Open state that follows the opened row: when it moves into this group, the group opens to show it. */
function useFoldOpen(
  defaultOpen: boolean,
  revealIndex: number,
  listRef: RefObject<HTMLUListElement | null>,
) {
  const holdsReveal = revealIndex >= 0;
  const [open, setOpen] = useState(defaultOpen || holdsReveal);
  const [heldReveal, setHeldReveal] = useState(holdsReveal);

  // Adjusted during render, so the group is already open in the commit that brings the row in.
  if (heldReveal !== holdsReveal) {
    setHeldReveal(holdsReveal);
    if (holdsReveal) setOpen(true);
  }

  // Its old button unmounted with the move, so focus follows the row instead of dropping to the page.
  useEffect(() => {
    if (!heldReveal || (document.activeElement && document.activeElement !== document.body)) return;
    listRef.current?.children[revealIndex]?.querySelector('button')?.focus();
  }, [heldReveal, revealIndex, listRef]);

  return [open, setOpen] as const;
}

/** The accordion row: title, count badge and a chevron that every group lines up on. */
function FoldHeading({
  title,
  count,
  disabled,
  action,
}: {
  title: string;
  count: number;
  disabled: boolean;
  action?: ReactNode;
}): ReactElement {
  return (
    <h3 className="relative flex items-center font-medium text-sm">
      <CollapsibleTrigger
        disabled={disabled}
        className="group/fold flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[10px] px-2 text-left text-ink transition-colors duration-150 ease-out hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent data-[state=closed]:py-3 data-[state=open]:py-1.5 data-[state=open]:text-muted-fg motion-reduce:transition-none"
      >
        <span className="truncate">{title}</span>
        <span className="rounded-md bg-foreground/[0.06] px-1.5 py-px font-normal text-muted-fg text-xs tabular-nums">
          {count}
        </span>
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 shrink-0 text-dim transition-transform duration-150 ease-out group-data-[state=open]/fold:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      {/* Beside the trigger, not in it (no nested buttons), and left of the chevron so every chevron lines up. */}
      {action ? <span className="absolute top-1/2 right-9 -translate-y-1/2">{action}</span> : null}
    </h3>
  );
}

function ShowMoreRow({ hidden, onClick }: { hidden: number; onClick: () => void }): ReactElement {
  return (
    <li className="border-hairline border-b">
      <button
        type="button"
        onClick={onClick}
        className="w-full cursor-pointer rounded-[10px] px-2 py-2.5 text-left text-sm text-muted-fg transition-colors duration-150 ease-out hover:bg-foreground/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        {`Show ${hidden} more`}
      </button>
    </li>
  );
}

/** A heading that folds its list away, with the count kept visible so a closed group still says what it holds. */
export function SettingsFoldGroup<T>({
  title,
  items,
  itemKey,
  renderItem,
  defaultOpen,
  forceOpen = false,
  uncapped = false,
  revealKey = null,
  action,
  listClassName,
}: FoldGroupProps<T>): ReactElement {
  const listRef = useRef<HTMLUListElement>(null);
  const revealIndex =
    revealKey === null ? -1 : items.findIndex((item) => itemKey(item) === revealKey);
  const [open, setOpen] = useFoldOpen(defaultOpen, revealIndex, listRef);
  const [showMore, setShowMore] = useState(false);
  // Derived, not stored: the opened row lifts the cap wherever it lands, including after a search clears.
  const capped =
    !uncapped && !showMore && revealIndex < FOLD_GROUP_CAP && items.length > FOLD_GROUP_CAP;
  const visible = capped ? items.slice(0, FOLD_GROUP_CAP) : items;

  // The "Show N more" button disappears on click, so focus moves to the first row it revealed.
  const handleShowMore = () => {
    flushSync(() => setShowMore(true));
    listRef.current?.children[FOLD_GROUP_CAP]?.querySelector('button')?.focus();
  };

  return (
    <Collapsible asChild open={open || forceOpen} onOpenChange={setOpen}>
      {/* Folded groups drop the parent's zero-specificity space-y and share hairlines, so they stack as one accordion. */}
      <section
        aria-label={title}
        className="border-hairline data-[state=closed]:mb-0 data-[state=closed]:border-y [[data-state=closed]+&]:border-t-0"
      >
        <FoldHeading title={title} count={items.length} disabled={forceOpen} action={action} />
        <CollapsibleContent asChild>
          <ul ref={listRef} className={cn('border-hairline border-t', listClassName)}>
            {visible.map((item) => (
              <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>
            ))}
            {capped ? (
              <ShowMoreRow hidden={items.length - FOLD_GROUP_CAP} onClick={handleShowMore} />
            ) : null}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** The one line a search with no results leaves on the page. */
export function SettingsNoMatches({ noun, query }: { noun: string; query: string }) {
  return (
    <p className="py-8 text-center text-muted-fg text-sm">{`No ${noun} match “${query.trim()}”.`}</p>
  );
}

/** The list search, right-aligned above the groups. */
export function SettingsSearch({
  noun,
  value,
  onChange,
}: {
  noun: string;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="relative ml-auto w-full min-w-[11rem] max-w-[16rem]">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-dim"
      />
      <Input
        size="sm"
        type="search"
        value={value}
        placeholder={`Search ${noun}`}
        aria-label={`Search ${noun}`}
        onChange={(event) => onChange(event.target.value)}
        className="pl-8"
      />
    </div>
  );
}

/** Neutral plate for rows and empty states that have no brand of their own. */
export function GlyphTile({ icon: Icon }: { icon: ComponentType<{ className?: string }> }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-muted-fg ring-1 ring-hairline ring-inset">
      <Icon className="size-[18px]" />
    </span>
  );
}

type RowProps = {
  id: string;
  /** Only where it carries identity (a plugin's mark, a server). */
  tile?: ReactNode;
  name: string;
  description: ReactNode;
  /** Replaces the muted description colour, e.g. an error reason in red. */
  descriptionClassName?: string;
  /** The one pill or status word, in a fixed left-aligned slot so dots and pills form a column. */
  status?: ReactNode;
  /** Turned off: a colour step, not opacity, so the text stays readable. */
  dimmed?: boolean;
  expanded: boolean;
  onToggle: () => void;
  menu?: ReactNode;
  details: ReactNode;
};

/** The row's ⋯ menu: kept out of the row button (no nested controls) and faded in on hover or focus. */
function RowMenu({ name, menu }: { name: string; menu: ReactNode }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={`More actions for ${name}`}
          className="absolute top-1/2 right-2 size-7 -translate-y-1/2 p-0 text-muted-fg opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowBody({ indented, children }: { indented: boolean; children: ReactNode }): ReactElement {
  return (
    <div
      className={cn(
        'pr-4 pb-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150',
        indented ? 'pl-[3.875rem]' : 'pl-2',
      )}
    >
      <div className="space-y-3 border-hairline border-t pt-3">{children}</div>
    </div>
  );
}

export function SettingsListRow({
  id,
  tile,
  name,
  description,
  descriptionClassName = 'text-muted-fg',
  status,
  dimmed = false,
  expanded,
  onToggle,
  menu,
  details,
}: RowProps): ReactElement {
  return (
    <li
      data-setup-row={id}
      className={cn(
        'group/row border-hairline border-b',
        expanded && 'rounded-[10px] bg-foreground/[0.04]',
      )}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className={cn(
            'flex w-full cursor-pointer items-center gap-3.5 rounded-[10px] px-2 py-3 text-left transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
            !expanded && 'hover:bg-foreground/5',
          )}
        >
          {tile ? <span className={cn('shrink-0', dimmed && 'opacity-60')}>{tile}</span> : null}
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate font-medium text-sm',
                dimmed ? 'text-muted-fg' : 'text-ink',
              )}
            >
              {name}
            </span>
            <span
              className={cn(
                'mt-0.5 block text-sm',
                expanded ? 'whitespace-pre-wrap leading-relaxed' : 'truncate',
                descriptionClassName,
              )}
            >
              {description}
            </span>
          </span>
          <span className="flex w-28 shrink-0 items-center">{status}</span>
          <span className="size-7 shrink-0" aria-hidden />
        </button>

        {menu ? <RowMenu name={name} menu={menu} /> : null}
      </div>

      {expanded ? <RowBody indented={Boolean(tile)}>{details}</RowBody> : null}
    </li>
  );
}

/** An opened row's small label/value list. */
export function RowDetails({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode } | null>;
}): ReactElement {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 text-sm">
      {items.map((item) =>
        item ? (
          <div key={item.label} className="contents">
            <dt className="text-muted-fg">{item.label}</dt>
            <dd className="min-w-0 text-ink">{item.value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

type EmptyProps = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
  action?: ReactNode;
};

export function SettingsEmptyState({ icon: Icon, title, body, action }: EmptyProps) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <GlyphTile icon={Icon} />
      <p className="mt-4 font-medium text-ink text-sm">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-fg leading-relaxed">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
