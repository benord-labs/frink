/**
 * RunStatusRow — the ONE chat-level status surface above the composer. Every end-of-run
 * affordance (accept, retry/carry-on, resume-interrupted) renders through this row so the user
 * learns a single grammar: colored state dot + muted label on the left, ghost actions on the
 * right, terminal action rightmost. State identity lives in the DOT + action tint, never in
 * banner chrome. The states are mutually exclusive, so at most one row shows at a time.
 *
 * Chat-level rather than message-anchored on purpose: a run can end with no assistant message
 * (pre-stream failure, cancelled follow-up), which orphans any message-anchored control.
 */

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type RunStatusRowProps = {
  /** Theme token class for the state dot, e.g. 'bg-[hsl(var(--status-online))]'. */
  dotClassName: string;
  /** The state, always shown. */
  label: ReactNode;
  /** Optional hint after the state; the first thing to go when the pane narrows. */
  detail?: ReactNode;
  /** Ghost buttons, each an icon + a text <span>; below the icon tier only the icon shows. */
  children: ReactNode;
};

export function RunStatusRow({ dotClassName, label, detail, children }: RunStatusRowProps) {
  return (
    // role="status": rows mount asynchronously (a poll surfaces the state) — announce them.
    <div className="px-2 relative z-10" role="status">
      {/* One row at every width, sized on the chat pane: the detail goes first (40rem), then the
          action labels (26rem, icon squares keep aria-label + tooltip); the state always stays. */}
      <div className="@container/run-status w-full max-w-2xl mx-auto px-2 mb-1 glass-float rounded-xl border border-border">
        <div className="flex items-start justify-between gap-2 px-1 py-1">
          <span className="flex min-w-0 flex-1 items-start gap-2 py-1.5 text-xs text-muted-foreground">
            <span
              className={cn('mt-[5px] h-1.5 w-1.5 rounded-full shrink-0', dotClassName)}
              aria-hidden="true"
            />
            <span>
              {label}
              {detail ? <span className="@max-[40rem]/run-status:hidden"> — {detail}</span> : null}
            </span>
          </span>
          <div className="flex shrink-0 items-center gap-1 @max-[26rem]/run-status:[&_button]:w-7 @max-[26rem]/run-status:[&_button]:justify-center @max-[26rem]/run-status:[&_button]:px-0 @max-[26rem]/run-status:[&_button>span]:hidden">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
