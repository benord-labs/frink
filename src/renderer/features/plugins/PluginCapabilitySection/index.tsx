/**
 * One capability row, drawn at the weight its content deserves.
 *
 * The variants follow what a row *is*, not how it looks. An inventory of things
 * the package gives you is a ruled table or a chip rack; a single scalar fact
 * about the package is a term and a value; a compatibility matrix is reference
 * material and reads a full type step quieter. Drawing all seven rows
 * identically is what flattened this page into a wall of same-width boxes.
 *
 * Every row still renders when empty — see `toCapabilityRows`. Absence is
 * stated, never implied by omission. Inventory rows preserve notes and write-risk
 * markers; the compatibility matrix states support through its cells alone.
 *
 * The reference tier is laid out with CONTAINER queries, so it needs an
 * `@container` ancestor: `PluginDetail` puts one on the page frame.
 */
import { Badge } from '@benord-labs/frink-primitives';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { PluginCapabilityRow } from '../../../lib/plugins/plugin-view-model';
import { WorksInTable } from './WorksInTable';

/**
 * `list` and `chips` are the loud tier — what you get. `fact` and `matrix` are
 * the reference tier at the foot of the page.
 */
type PluginCapabilityVariant = 'list' | 'chips' | 'fact' | 'matrix';

type Items = PluginCapabilityRow['items'];

type Props = {
  row: PluginCapabilityRow;
  /** How the row is drawn. Defaults to the ruled list. */
  variant?: PluginCapabilityVariant;
};

/**
 * The reference tier's column, shared so Source, Auth and every runtime line up
 * as one table.
 *
 * `@[34rem]` measures the page container, never the viewport. This page renders
 * inside a settings pane, so a `sm:` breakpoint would be active on a 1440px
 * window while the pane was 420px wide, leaving the longest copy on the page
 * about 250px and wrapping every runtime reason onto four lines. Below the
 * threshold the term stacks over its value instead.
 */
const TERM_GRID = 'grid gap-x-5 gap-y-0.5 @[34rem]:grid-cols-[9rem_minmax(0,1fr)]';

const LOUD_HEADING = 'font-semibold text-ink text-lg tracking-[-0.01em]';
const QUIET_HEADING = 'font-medium text-muted-fg text-xs';
/** A reference-tier section title: one step above its terms, still far below the loud tier. */
export const REFERENCE_HEADING = 'font-medium text-ink text-sm';
/** Reference-tier value: a step above its 12px term, so the prose is the legible half. */
const REFERENCE_VALUE = 'text-sm text-ink leading-5';

/**
 * "Agent tools (2)" as one string, so a heading stays findable as the whole it names. The matrix
 * omits the count: its rows are runtimes, not things the plugin gives you.
 */
function headingText(row: PluginCapabilityRow): string {
  return row.items.length > 0 ? `${row.label} (${row.items.length})` : row.label;
}

export function PluginCapabilitySection({ row, variant = 'list' }: Props) {
  if (variant === 'fact') return <CapabilityFact row={row} />;

  const quiet = variant === 'matrix';

  return (
    <section>
      <h2 className={quiet ? REFERENCE_HEADING : LOUD_HEADING}>
        {quiet ? row.label : headingText(row)}
      </h2>

      {row.items.length === 0 ? (
        <p className={quiet ? 'mt-2 text-muted-fg text-xs' : 'mt-2.5 text-muted-fg text-sm'}>
          {row.emptyCopy}
        </p>
      ) : (
        <CapabilityItems items={row.items} variant={variant} />
      )}
    </section>
  );
}

function CapabilityItems({ items, variant }: { items: Items; variant: PluginCapabilityVariant }) {
  // A chip holds a bare label and nothing else. A note is prose and an
  // `onSelect` is a control, so a row carrying either falls back to the ruled
  // table rather than being drawn in a shape that would drop it.
  const bare = items.every((item) => !item.note && !item.onSelect);
  if (variant === 'chips' && bare) return <ChipRack items={items} />;
  if (variant === 'matrix') return <WorksInTable items={items} />;
  return <CapabilityList items={items} />;
}

/** The one marker for an action that stays inert until the user grants it. */
function RiskBadge() {
  return (
    <Badge variant="warning" shape="tag" noDot className="shrink-0 px-1.5 py-0.5">
      Needs approval
    </Badge>
  );
}

/**
 * One ruled table per section, not one bordered box per item. The note sits
 * beside its label rather than under it, so an item is one line and the notes
 * form a column the eye can run down. The risk markers get a column of their
 * own on the right, so which tools mutate the provider is scannable without
 * reading every label.
 */
function CapabilityList({ items }: { items: Items }) {
  return (
    <ul className="mt-3 divide-hairline divide-y border-hairline border-y">
      {items.map((item) => (
        <li key={item.id}>
          {item.onSelect ? (
            <button
              type="button"
              onClick={item.onSelect}
              className="group flex w-full items-center gap-x-3 px-2 py-3 text-left outline-none transition-colors duration-150 ease-out hover:bg-muted focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <ItemBody item={item} />
              <ChevronRight
                className="size-4 shrink-0 text-muted-fg transition-transform duration-150 ease-out motion-safe:group-hover:translate-x-0.5"
                aria-hidden
              />
            </button>
          ) : (
            <div className="flex items-center gap-x-3 px-2 py-3">
              <ItemBody item={item} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Label and note wrap as flex siblings inside a group that takes the whole row,
 * which is what pushes the risk marker into its own right-hand column. A narrow
 * pane wraps the note onto its own line instead of squeezing two columns too
 * thin to hold text.
 */
function ItemBody({ item }: { item: Items[number] }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-0 grow basis-[15rem] break-words font-medium text-ink text-sm">
          {item.label}
        </span>
        {item.note ? (
          <span className="min-w-0 grow basis-[20rem] break-words text-muted-fg text-xs">
            {item.note}
          </span>
        ) : null}
      </span>
      {item.writeRisk ? <RiskBadge /> : null}
    </>
  );
}

/**
 * Short bare labels pack inline. A full-width bordered box for a three-word
 * trigger name was this page's worst horizontal waste.
 *
 * Filled rather than outlined: `bg-elevated` resolves to the page background in
 * light theme, which made the same chip read as a filled thing in dark and an
 * empty outline in light. `bg-muted` is a real surface in both, so the fill is
 * the whole treatment and the border is not needed.
 */
function ChipRack({ items }: { items: Items }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-ink text-sm"
        >
          {item.label}
          {item.writeRisk ? <RiskBadge /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A term and its value, on the reference tier's shared column. Rendered inside
 * the tier's `<dl>`, so the term is a `<dt>` under the tier's one heading.
 *
 * Every item is printed — a provider can declare more than one credential, and
 * showing only the first would drop the rest. A stated absence is italic so it
 * reads as "we checked and there is none" rather than as another value.
 */
function CapabilityFact({ row }: { row: PluginCapabilityRow }) {
  return (
    <div className={TERM_GRID}>
      <dt className={QUIET_HEADING}>{headingText(row)}</dt>
      {row.items.length === 0 ? (
        <dd className="text-muted-fg text-xs italic">{row.emptyCopy}</dd>
      ) : (
        <dd className="space-y-0.5">
          {row.items.map((item) => (
            <p key={item.id} className={REFERENCE_VALUE}>
              {item.label}
              {item.note ? <span className="text-muted-fg"> · {item.note}</span> : null}
              {item.href ? <SourceLink href={item.href} label={item.hrefLabel} /> : null}
            </p>
          ))}
        </dd>
      )}
    </div>
  );
}

/** The official vendor destination, or the acquired package when no vendor destination is known. */
function SourceLink({ href, label = 'View source' }: { href: string; label?: string }) {
  return (
    <span className="text-muted-fg">
      {' · '}
      <button
        type="button"
        onClick={() => window.desktopApi.openExternal(href)}
        className="inline-flex items-center gap-1 rounded-sm underline-offset-2 outline-none transition-colors duration-150 ease-out hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
      >
        {label}
        <ExternalLink className="size-3" aria-hidden />
      </button>
    </span>
  );
}
