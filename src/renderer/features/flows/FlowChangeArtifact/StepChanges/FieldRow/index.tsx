import { ArrowRight, ChevronDown } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import type {
  StepFieldChange,
  TextDiffSize,
  TextFieldChange,
} from '../../../../../lib/flows/flow-step-diff';
import { cn } from '../../../../../lib/utils';
import { DiffBody, DiffSegments } from '../DiffBody';

const SIZE_COPY: Record<TextDiffSize, string> = {
  formatting: 'Formatting only',
  tiny: 'Tiny edit',
  small: 'Small edit',
  edited: 'Edited',
  rewritten: 'Rewritten',
};
const ROW_CLASS = 'min-w-0 px-3 py-2';
const NAME_CLASS = 'text-sm font-medium text-foreground';

function SizeBadge({ size }: { size: TextDiffSize }): ReactElement {
  return (
    <span
      className={cn(
        'rounded-full border border-border px-2 text-xs leading-5 text-foreground',
        (size === 'tiny' || size === 'formatting') && 'text-muted-foreground',
        size === 'rewritten' &&
          'border-[hsl(var(--status-warning-foreground)/0.4)] text-[hsl(var(--status-warning-foreground))]',
      )}
    >
      {SIZE_COPY[size]}
    </span>
  );
}

function TextFieldRow({ field, defaultOpen }: { field: TextFieldChange; defaultOpen: boolean }) {
  const { diff } = field;
  const expandable = diff.size !== 'formatting';
  const [open, setOpen] = useState(defaultOpen && expandable);
  const panelId = useId();
  return (
    <li className={ROW_CLASS}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-0 bg-transparent p-0 text-left disabled:cursor-default"
        disabled={!expandable}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className={NAME_CLASS}>{field.label}</span>
        <SizeBadge size={diff.size} />
        {expandable && diff.addedWords !== undefined ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            <span className="text-green-700 dark:text-green-300">+{diff.addedWords}</span>{' '}
            <span className="text-red-700 dark:text-red-300">−{diff.removedWords}</span>
            <span className="@max-[420px]:hidden"> words</span>
          </span>
        ) : null}
        {expandable ? (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'ml-auto size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        ) : null}
      </button>
      {!open && field.showPreview && diff.preview.length > 0 ? (
        <p className="m-0 mt-1 truncate text-sm text-muted-foreground">
          <DiffSegments segments={diff.preview} swaps />
        </p>
      ) : null}
      <div className="mt-2" hidden={!open} id={panelId}>
        {open ? <DiffBody field={field} /> : null}
      </div>
    </li>
  );
}

export function FieldRow({
  field,
  defaultOpen,
}: {
  field: StepFieldChange;
  defaultOpen: boolean;
}): ReactElement {
  if (field.kind === 'text') return <TextFieldRow defaultOpen={defaultOpen} field={field} />;
  if (field.kind === 'label') {
    return (
      <li className={cn(ROW_CLASS, 'flex items-baseline gap-2')}>
        <span className={NAME_CLASS}>{field.label}</span>
        <span className="text-xs text-muted-foreground">changed</span>
      </li>
    );
  }
  return (
    <li className={cn(ROW_CLASS, 'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm')}>
      <span className={NAME_CLASS}>{field.label}</span>
      <span className="text-muted-foreground line-through wrap-anywhere">{field.before}</span>
      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="sr-only">changed to</span>
      <span className="text-foreground wrap-anywhere">{field.after}</span>
    </li>
  );
}
