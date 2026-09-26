// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the bounded Flow outline must receive keyboard focus so it can scroll.

import { memo, type ReactElement, useId, useMemo, useState } from 'react';
import type {
  FlowChangeOperationStatus,
  FlowChangePhase,
  FlowChangePresentation,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import {
  buildFlowChangeOutline,
  type FlowChangeOutlineModel,
} from '../../../lib/flows/flow-change-outline';
import { FlowChangeOutline } from './FlowChangeOutline';
import { FlowChangeReceipt } from './FlowChangeReceipt';

type Props = {
  presentation: FlowChangePresentation;
  onOpenFlow?: (flowId: string) => void;
  defaultExpanded?: boolean;
  /** Inside another glass card (a subagent's): a tint, not a second glass. */
  nested?: boolean;
};

type ChangeCounts = Record<FlowChangeOperationStatus, number>;

type SummaryContext = {
  presentation: FlowChangePresentation;
  counts: ChangeCounts;
  scope: string;
  canOpenFlow: boolean;
  synopsis?: string;
};

const FLOW_STATUS_BY_PHASE: Record<Exclude<FlowChangePhase, 'applied'>, string> = {
  proposed: 'Flow change proposed',
  applying: 'Updating Flow',
  partial: 'Flow partly updated',
  unchanged: 'Flow is current',
  failed: 'Flow not updated',
  denied: 'Flow not updated',
  stale: 'Flow changed elsewhere',
  unconfirmed: 'Check this Flow',
  interrupted: 'Check this Flow',
};

function countChanges(changes: FlowSemanticChange[]): ChangeCounts {
  const counts: ChangeCounts = {
    pending: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
    unchanged: 0,
    unknown: 0,
  };
  for (const change of changes) counts[change.status] += 1;
  return counts;
}

function changeScope(changes: FlowSemanticChange[]): string {
  const steps = changes.filter((change) => change.kind === 'node').length;
  const routes = changes.filter((change) => change.kind === 'edge').length;
  const settings = changes.filter((change) => change.kind === 'settings').length;
  const parts = [
    steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : '',
    routes > 0 ? `${routes} ${routes === 1 ? 'route' : 'routes'}` : '',
    settings > 0 ? `${settings} ${settings === 1 ? 'setting change' : 'settings changes'}` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'No reported changes';
}

function partialSummary(counts: ChangeCounts): string {
  return [
    counts.applied > 0 ? `${counts.applied} applied` : '',
    counts.unchanged > 0 ? `${counts.unchanged} already current` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.skipped > 0 ? `${counts.skipped} not applied` : '',
    counts.unknown > 0 ? `${counts.unknown} unconfirmed` : '',
    counts.pending > 0 ? `${counts.pending} pending` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function uncertainSummary({ canOpenFlow }: SummaryContext): string {
  return canOpenFlow
    ? 'Outcome unknown. Open the Flow to verify.'
    : 'Outcome unknown. Verify before retrying.';
}

const SUMMARY_FOR_PHASE: Record<FlowChangePhase, (context: SummaryContext) => string> = {
  proposed: ({ scope, synopsis }) => synopsis ?? `${scope} proposed`,
  applying: ({ scope, synopsis }) => synopsis ?? `${scope} in progress`,
  applied: ({ presentation, scope, synopsis }) =>
    synopsis ?? `${presentation.mode === 'create' ? 'Created' : 'Updated'} ${scope}`,
  partial: ({ counts, synopsis }) =>
    [synopsis, partialSummary(counts)].filter(Boolean).join('. ') || 'Partially applied',
  unchanged: () => 'No new version saved',
  failed: () => 'The change was not saved',
  denied: ({ presentation }) => presentation.denialReason ?? 'Nothing changed',
  stale: () => 'Changed elsewhere. Refresh before retrying',
  unconfirmed: uncertainSummary,
  interrupted: uncertainSummary,
};

function summaryFor(
  presentation: FlowChangePresentation,
  counts: ChangeCounts,
  canOpenFlow: boolean,
  synopsis?: string,
): string {
  return SUMMARY_FOR_PHASE[presentation.phase]({
    presentation,
    counts,
    scope: changeScope(presentation.changes),
    canOpenFlow,
    synopsis,
  });
}

function flowStatus(presentation: FlowChangePresentation): string {
  if (presentation.phase === 'applied') {
    return presentation.mode === 'create' ? 'Flow created' : 'Flow updated';
  }
  return FLOW_STATUS_BY_PHASE[presentation.phase];
}

function OutlineDetails({
  detailsId,
  expanded,
  outline,
}: {
  detailsId: string;
  expanded: boolean;
  outline: FlowChangeOutlineModel;
}): ReactElement {
  if (!expanded) return <div hidden id={detailsId} />;
  return (
    <div
      aria-label="Flow structure"
      className="max-h-[min(340px,52vh)] overflow-y-auto overscroll-contain border-t border-border/60 contrast-more:border-foreground"
      data-slot="flow-change-details"
      id={detailsId}
      role="region"
      tabIndex={0}
    >
      <FlowChangeOutline outline={outline} />
    </div>
  );
}

export const FlowChangeArtifact = memo(function FlowChangeArtifact({
  presentation,
  onOpenFlow,
  defaultExpanded,
  nested,
}: Props): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const detailsId = useId();
  const titleId = useId();
  const counts = useMemo(() => countChanges(presentation.changes), [presentation.changes]);
  // AgentFlowTool rebuilds this semantic presentation whenever its mutable MessagePart changes.
  const outline = useMemo(() => buildFlowChangeOutline(presentation), [presentation]);
  const canOpenFlow = Boolean(presentation.flowId && onOpenFlow);
  const summary = summaryFor(presentation, counts, canOpenFlow, outline.synopsis);
  const status = flowStatus(presentation);
  const canInspect =
    outline.routes.length > 0 ||
    outline.settingsChanges.length > 0 ||
    outline.unplacedChanges.length > 0;

  return (
    <section
      aria-labelledby={titleId}
      className={`@container w-full min-w-0 overflow-hidden rounded-[10px] border border-border/75 ${nested ? 'bg-muted/30' : 'glass-card'} contrast-more:border-foreground`}
      data-phase={presentation.phase}
    >
      <FlowChangeReceipt
        canInspect={canInspect}
        detailsId={detailsId}
        expanded={expanded}
        onOpenFlow={onOpenFlow}
        onToggle={() => setExpanded((current) => !current)}
        presentation={presentation}
        status={status}
        summary={summary}
        titleId={titleId}
      />

      <span aria-atomic="true" aria-live="polite" className="sr-only">
        {presentation.name}. {status}. {summary}.
      </span>

      <OutlineDetails detailsId={detailsId} expanded={expanded} outline={outline} />
    </section>
  );
});
