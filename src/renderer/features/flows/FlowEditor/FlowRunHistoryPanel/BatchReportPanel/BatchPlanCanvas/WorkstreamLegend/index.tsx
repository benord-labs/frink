/**
 * Compact workstream legend overlay for the BatchPlanCanvas.
 *
 * Positioned at bottom-right to avoid occluding dagre TB-layout top nodes.
 * Each entry shows a color dot, a 2-char abbreviation (WCAG secondary signal),
 * and the truncated workstream name.
 *
 * Only rendered by the parent when >= 2 unique workstreams exist.
 * pointer-events-none ensures it does not block node interaction.
 */

import { memo, type ReactElement } from 'react';
import { getWorkstreamAbbrev, getWorkstreamColor } from '../workstream-colors';

export type WorkstreamLegendEntry = {
  workstreamId: string;
};

type WorkstreamLegendProps = {
  workstreams: WorkstreamLegendEntry[];
};

function WorkstreamLegendInner({ workstreams }: WorkstreamLegendProps): ReactElement {
  return (
    <div
      className="pointer-events-none absolute bottom-2 right-2 z-10 flex flex-col gap-0.5 rounded border border-border/40 bg-card px-1.5 py-1"
      aria-label="Workstream legend"
      role="list"
    >
      {workstreams.map(({ workstreamId }) => {
        const color = getWorkstreamColor(workstreamId);
        const abbrev = getWorkstreamAbbrev(workstreamId);
        return (
          <div key={workstreamId} role="listitem" className="flex items-center gap-1 min-w-0">
            {/* Color dot */}
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            {/* Abbreviation — WCAG secondary signal alongside color */}
            <span
              className="shrink-0 text-[8px] font-bold tabular-nums leading-tight"
              style={{ color }}
            >
              {abbrev}
            </span>
            {/* Truncated name */}
            <span
              className="max-w-[80px] truncate text-[8px] leading-tight text-muted-foreground/70"
              title={workstreamId}
            >
              {workstreamId}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const WorkstreamLegend = memo(WorkstreamLegendInner);
