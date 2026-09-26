/**
 * Shared renderers for {@link TriggerSummary} fields + changes — used by BOTH the in-chat
 * TriggerBubble and the Work Queue TriggerContentDialog so the two surfaces never diverge.
 */
import type { ReactElement } from 'react';
import type { TriggerSummaryChange, TriggerSummaryTone } from '../../../shared/lib/trigger-summary';
import { cn } from '../../lib/utils';

const TRIGGER_BADGE_STYLES: Record<TriggerSummaryTone, string> = {
  primary: 'bg-primary/15 text-primary',
  green: 'bg-[hsl(var(--status-online)/0.15)] text-[hsl(var(--status-online-text))]',
  amber: 'bg-amber-500/15 text-warning',
  neutral: 'bg-secondary text-secondary-foreground',
};

/** A single label → value row; renders a validated external link when `href` is present. */
export function TriggerSummaryFieldRow({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string | number;
  tone?: TriggerSummaryTone;
  href?: string;
}): ReactElement {
  const text = String(value);
  const valueClass = tone
    ? cn(
        'rounded-full px-2 py-0.5 text-xs font-medium truncate max-w-[60%]',
        TRIGGER_BADGE_STYLES[tone],
      )
    : 'text-sm text-foreground font-medium truncate max-w-[60%] text-right';
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(valueClass, 'hover:underline cursor-pointer')}
        >
          {text}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      ) : (
        <span className={valueClass}>{text}</span>
      )}
    </div>
  );
}

/** "What changed" rows (old → new). Renders nothing when there are no changes. */
export function TriggerSummaryChanges({
  changes,
}: {
  changes: TriggerSummaryChange[] | undefined;
}): ReactElement | null {
  if (!changes || changes.length === 0) return null;
  return (
    <div className="space-y-1">
      {changes.map((c) => (
        <div key={c.label} className="flex items-baseline gap-1.5 text-xs">
          <span className="text-muted-foreground">{c.label}:</span>
          {c.from && <span className="text-foreground/70 line-through">{c.from}</span>}
          {c.from && c.to && <span className="text-muted-foreground">→</span>}
          {c.to && <span className="text-foreground font-medium">{c.to}</span>}
        </div>
      ))}
    </div>
  );
}
