import { Button } from '@benord-labs/frink-primitives';
import { memo, type ReactElement, useState } from 'react';
import type { StepChangeEntry } from '../../../../lib/flows/flow-step-diff';
import { focusOnMount } from './DiffBody';
import { FieldRow } from './FieldRow';

type Props = { entries: StepChangeEntry[] };

/** Beyond this many steps the list stops growing until the user asks, so the chat stays readable. */
const VISIBLE_STEPS = 3;

function fieldKey(entry: StepChangeEntry, label: string): string {
  return `${entry.nodeId}:${label}`;
}

/** The first text field starts open, unless its text is only shown on request (a command line). */
function firstTextFieldKey(entries: StepChangeEntry[]): string | undefined {
  for (const entry of entries) {
    const field = entry.fields.find(
      (candidate) =>
        candidate.kind === 'text' && candidate.showPreview && candidate.diff.size !== 'formatting',
    );
    if (field) return fieldKey(entry, field.label);
  }
  return undefined;
}

type StepEntryProps = { entry: StepChangeEntry; openKey?: string; takeFocus?: boolean };

function StepEntry({ entry, openKey, takeFocus }: StepEntryProps) {
  return (
    <li
      className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/20 outline-none contrast-more:border-foreground"
      ref={takeFocus ? focusOnMount : undefined}
      tabIndex={takeFocus ? -1 : undefined}
    >
      <div className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/50 px-3 py-2">
        <span
          aria-hidden="true"
          className="mt-1.5 size-2 rounded-full bg-[hsl(var(--status-online-text))]"
        />
        <strong className="min-w-0 text-sm font-medium text-foreground wrap-anywhere">
          {entry.label}
        </strong>
        {entry.blockTypeLabel ? (
          <span className="text-xs leading-5 text-muted-foreground @max-[420px]:hidden">
            {entry.blockTypeLabel}
          </span>
        ) : null}
        {entry.path.length > 0 ? (
          <span className="col-start-2 col-end-4 text-xs text-muted-foreground wrap-anywhere">
            {entry.path.join(' › ')}
          </span>
        ) : null}
      </div>
      <ul className="m-0 list-none divide-y divide-border/50 p-0">
        {entry.fields.map((field) => (
          <FieldRow
            defaultOpen={fieldKey(entry, field.label) === openKey}
            field={field}
            key={field.label}
          />
        ))}
      </ul>
    </li>
  );
}

export const StepChanges = memo(function StepChanges({ entries }: Props): ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  if (entries.length === 0) return null;
  const visible = showAll ? entries : entries.slice(0, VISIBLE_STEPS);
  const hiddenCount = entries.length - visible.length;
  const openKey = firstTextFieldKey(entries);
  return (
    <section
      aria-label="What changed"
      className="min-w-0 border-t border-border/60 px-3 pt-2 pb-3 contrast-more:border-foreground"
      data-slot="flow-step-changes"
    >
      <h4 className="m-0 pb-1.5 text-xs font-medium text-muted-foreground">What changed</h4>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {visible.map((entry, index) => (
          <StepEntry
            entry={entry}
            key={entry.nodeId}
            openKey={openKey}
            takeFocus={showAll && index === VISIBLE_STEPS}
          />
        ))}
      </ol>
      {hiddenCount > 0 ? (
        <Button
          className="mt-1.5 h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setShowAll(true)}
          size="sm"
          variant="ghost"
        >
          Show {hiddenCount} more changed {hiddenCount === 1 ? 'step' : 'steps'}
        </Button>
      ) : null}
    </section>
  );
});
