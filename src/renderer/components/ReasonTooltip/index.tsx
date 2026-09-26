import type { ReactElement, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

type ReasonTooltipProps = {
  /** The concise ask — already rendered (truncated) as `children`; used as tooltip text when no details. */
  summary?: string | null;
  /** Longer context (the full plan/reasoning); shown in the tooltip when present. */
  details?: string | null;
  /** The visible line (e.g. a CSS-truncated reason span) that triggers the tooltip. */
  children: ReactNode;
};

/**
 * Wraps a (CSS-truncated) reason line in a Tooltip that reveals the fuller text on hover/keyboard
 * focus — `details` when the agent split context out, else the full `summary` (so a truncated line
 * is still readable). Renders `children` bare when there is nothing longer to show. Reused by flow
 * run receipts, paused actions, and other truncated summaries. The Tooltip provider is app-wide.
 * See sc-842 (the `summary` = concise ask / `details` = context split).
 */
export function ReasonTooltip({ summary, details, children }: ReasonTooltipProps): ReactElement {
  const content = details?.trim() || summary?.trim() || null;
  if (!content) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
