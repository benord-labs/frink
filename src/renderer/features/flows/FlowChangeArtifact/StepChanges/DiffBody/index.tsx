import { type ReactElement, useState } from 'react';
import type {
  DiffParagraph,
  DiffSegment,
  TextFieldChange,
} from '../../../../../lib/flows/flow-step-diff';
import { cn } from '../../../../../lib/utils';

const ADDED_CLASS =
  'rounded-[3px] bg-green-500/10 text-green-700 no-underline dark:bg-green-500/15 dark:text-green-300';
const REMOVED_CLASS =
  'rounded-[3px] bg-red-500/10 text-red-700 line-through decoration-red-500 decoration-2 dark:bg-red-500/15 dark:text-red-300';
const PROSE_CLASS = 'm-0 whitespace-pre-wrap text-sm leading-6 wrap-anywhere';
const SMALL_BUTTON_CLASS =
  'cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:underline';
/** Longer new text starts clamped so one rewrite cannot take over the chat. */
const CLAMP_CHARS = 480;
const CLAMP_LINES = 6;

type SegmentsProps = { segments: DiffSegment[]; swaps?: boolean };

/** In a preview, an arrow joins a removal to its replacement and a comma separates swaps. */
function previewSeparator(previous: DiffSegment | undefined, current: DiffSegment): string | null {
  if (!previous) return null;
  return previous.kind === 'removed' && current.kind === 'added' ? ' → ' : ', ';
}

/** Moves keyboard focus to content that replaced the control the user just activated. */
export const focusOnMount = (node: HTMLElement | null) => node?.focus();

function ChangedSegment({ segments, swaps, index }: SegmentsProps & { index: number }) {
  const segment = segments[index];
  const previous = segments[index - 1];
  const Tag = segment.kind === 'added' ? 'ins' : 'del';
  return (
    <span>
      {swaps ? previewSeparator(previous, segment) : null}
      <Tag
        className={cn(
          segment.kind === 'added' ? ADDED_CLASS : REMOVED_CLASS,
          // A replacement sits flush against what it replaced; the gap keeps the two words apart.
          !swaps && previous?.kind === 'removed' && 'ml-1',
        )}
      >
        {swaps ? segment.text.trim() : segment.text}
      </Tag>
    </span>
  );
}

/** Renders changed words inline; `swaps` renders a one-line preview of each change. */
export function DiffSegments({ segments, swaps }: SegmentsProps): ReactElement {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'same' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <ChangedSegment index={index} key={index} segments={segments} swaps={swaps} />
        ),
      )}
    </>
  );
}

type DiffItem = { kind: 'paragraph'; paragraph: DiffParagraph } | { kind: 'folded'; count: number };

/** Changed paragraphs, with each run of unchanged ones collapsed to a count. */
function foldUnchanged(paragraphs: DiffParagraph[], showAll: boolean): DiffItem[] {
  const items: DiffItem[] = [];
  for (const paragraph of paragraphs) {
    const last = items[items.length - 1];
    if (showAll || paragraph.changed) items.push({ kind: 'paragraph', paragraph });
    else if (last?.kind === 'folded') last.count += 1;
    else items.push({ kind: 'folded', count: 1 });
  }
  return items;
}

function WordDiff({ paragraphs }: { paragraphs: DiffParagraph[] }): ReactElement {
  const [showAll, setShowAll] = useState(false);
  return (
    <div
      className="flex flex-col gap-2.5 outline-none"
      ref={showAll ? focusOnMount : undefined}
      tabIndex={-1}
    >
      {foldUnchanged(paragraphs, showAll).map((item, index) =>
        item.kind === 'folded' ? (
          <button
            className={`${SMALL_BUTTON_CLASS} rounded-md border border-dashed border-border px-2.5 py-1`}
            key={index}
            onClick={() => setShowAll(true)}
            type="button"
          >
            ··· {item.count} unchanged {item.count === 1 ? 'paragraph' : 'paragraphs'}
          </button>
        ) : (
          <p
            className={cn(PROSE_CLASS, !item.paragraph.changed && 'text-muted-foreground')}
            key={index}
          >
            <DiffSegments segments={item.paragraph.segments} />
          </p>
        ),
      )}
    </div>
  );
}

function Rewrite({ field }: { field: TextFieldChange }): ReactElement {
  const [full, setFull] = useState(
    field.after.length <= CLAMP_CHARS && field.after.split('\n').length <= CLAMP_LINES,
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-muted-foreground">
        Most of the text changed, so here is the new version.
      </p>
      <p className={cn(PROSE_CLASS, !full && 'line-clamp-6')}>{field.after}</p>
      {full ? null : (
        <button className={SMALL_BUTTON_CLASS} onClick={() => setFull(true)} type="button">
          Show all
        </button>
      )}
      <details className="border-t border-border/50 pt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">Previous version</summary>
        <p className={cn(PROSE_CLASS, 'mt-2 text-muted-foreground')}>{field.before}</p>
      </details>
    </div>
  );
}

export function DiffBody({ field }: { field: TextFieldChange }): ReactElement {
  return field.diff.size === 'rewritten' ? (
    <Rewrite field={field} />
  ) : (
    <WordDiff paragraphs={field.diff.paragraphs} />
  );
}
