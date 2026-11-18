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
  'rounded-[3px] bg-red-500/10 text-red-700 line-through decoration-red-500/60 dark:bg-red-500/15 dark:text-red-300';
const PROSE_CLASS = 'm-0 whitespace-pre-wrap text-sm leading-6 wrap-anywhere';
const SMALL_BUTTON_CLASS =
  'cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:underline';
/** Longer new text starts clamped so one rewrite cannot take over the chat. */
const CLAMP_CHARS = 480;

/** Renders changed words inline; `swaps` puts an arrow between a removal and its replacement. */
export function DiffSegments({
  segments,
  swaps,
}: {
  segments: DiffSegment[];
  swaps?: boolean;
}): ReactElement {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'same') return <span key={index}>{segment.text}</span>;
        const previous = swaps ? segments[index - 1] : undefined;
        const Tag = segment.kind === 'added' ? 'ins' : 'del';
        return (
          <span key={index}>
            {previous ? (previous.kind === 'removed' ? ' → ' : ', ') : null}
            <Tag className={segment.kind === 'added' ? ADDED_CLASS : REMOVED_CLASS}>
              {swaps ? segment.text.trim() : segment.text}
            </Tag>
          </span>
        );
      })}
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
    <div className="flex flex-col gap-2.5">
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
  const [full, setFull] = useState(field.after.length <= CLAMP_CHARS);
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
