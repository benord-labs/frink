import { Button } from '@benord-labs/frink-primitives';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { memo, type ReactElement } from 'react';
import type { FlowChangePresentation } from '../../../../../shared/types/flows/flow-change-presentation';
import { ReasonTooltip } from '../../../../components/ReasonTooltip';
import { TooltipProvider } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';
import { PHASE_META } from '../constants';

type Props = {
  canInspect: boolean;
  detailsId: string;
  expanded: boolean;
  presentation: FlowChangePresentation;
  status: string;
  summary: string;
  titleId: string;
  onOpenFlow?: (flowId: string) => void;
  onToggle: () => void;
};

type TooltipProps = {
  children: ReactElement;
  name: string;
  phaseLabel: string;
  summary: string;
};

type ChangeToggleProps = Omit<TooltipProps, 'children'> & {
  detailsId: string;
  expanded: boolean;
  onToggle: () => void;
};

type OpenFlowActionProps = Omit<TooltipProps, 'children'> & {
  flowId: string;
  withTooltip: boolean;
  onOpenFlow: (flowId: string) => void;
};

const PHASE_ACCENT_CLASS: Record<FlowChangePresentation['phase'], string> = {
  proposed: 'text-muted-foreground',
  applying: 'text-primary',
  applied: 'text-[hsl(var(--status-online-text))]',
  partial: 'text-[hsl(var(--status-warning-foreground))]',
  unchanged: 'text-[hsl(var(--status-online-text))]',
  failed: 'text-destructive',
  denied: 'text-destructive',
  stale: 'text-[hsl(var(--status-warning-foreground))]',
  unconfirmed: 'text-[hsl(var(--status-warning-foreground))]',
  unread: 'text-muted-foreground',
  interrupted: 'text-[hsl(var(--status-warning-foreground))]',
};

const ACTION_CLASS =
  'h-7 min-h-7 whitespace-nowrap px-2 text-[10px] forced-colors:focus-visible:[outline:2px_solid_Highlight] forced-colors:focus-visible:outline-offset-2 @max-[18rem]:w-7 @max-[18rem]:px-0';
const ACTION_LABEL_CLASS = '@max-[18rem]:sr-only';

function ReceiptCopyTooltip({ children, name, phaseLabel, summary }: TooltipProps): ReactElement {
  return (
    <TooltipProvider delayDuration={300}>
      <ReasonTooltip details={`${phaseLabel} · ${name}\n${summary}`}>{children}</ReasonTooltip>
    </TooltipProvider>
  );
}

function ChangeToggle({
  detailsId,
  expanded,
  name,
  phaseLabel,
  summary,
  onToggle,
}: ChangeToggleProps): ReactElement {
  return (
    <ReceiptCopyTooltip name={name} phaseLabel={phaseLabel} summary={summary}>
      <Button
        aria-controls={detailsId}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} Flow steps for ${name}`}
        className={cn(ACTION_CLASS, 'gap-1 text-muted-foreground')}
        onClick={onToggle}
        size="sm"
        variant="ghost"
      >
        <span className={ACTION_LABEL_CLASS}>{expanded ? 'Hide flow' : 'Show flow'}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3 -rotate-90 transition-transform duration-150 ease-out motion-reduce:transition-none',
            expanded && 'rotate-0',
          )}
        />
      </Button>
    </ReceiptCopyTooltip>
  );
}

function OpenFlowAction({
  flowId,
  name,
  phaseLabel,
  summary,
  withTooltip,
  onOpenFlow,
}: OpenFlowActionProps): ReactElement {
  const button = (
    <Button
      aria-label="Open Flow"
      className={cn(ACTION_CLASS, 'gap-1.5')}
      onClick={() => onOpenFlow(flowId)}
      size="sm"
      variant="secondary"
    >
      <span className={ACTION_LABEL_CLASS}>Open Flow</span>
      <ExternalLink aria-hidden="true" className="size-3" />
    </Button>
  );
  return withTooltip ? (
    <ReceiptCopyTooltip name={name} phaseLabel={phaseLabel} summary={summary}>
      {button}
    </ReceiptCopyTooltip>
  ) : (
    button
  );
}

function receiptMetadata(presentation: FlowChangePresentation): string {
  const stepCount = presentation.graph?.nodes.length ?? 0;
  const changeCount = presentation.changes.length;
  return [
    presentation.versionNumber == null ? '' : `Version ${presentation.versionNumber}`,
    stepCount > 0 ? `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}` : '',
    changeCount > 0 ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : '',
    presentation.warningCount > 0
      ? `${presentation.warningCount} ${presentation.warningCount === 1 ? 'warning' : 'warnings'}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const FlowChangeReceipt = memo(function FlowChangeReceipt({
  canInspect,
  detailsId,
  expanded,
  presentation,
  status,
  summary,
  titleId,
  onOpenFlow,
  onToggle,
}: Props): ReactElement {
  const phaseMeta = PHASE_META[presentation.phase];
  // biome-ignore lint/style/useNamingConvention: component type variable
  const PhaseIcon = phaseMeta.icon;
  const canOpenFlow = Boolean(presentation.flowId && onOpenFlow);
  const metadata = receiptMetadata(presentation);
  const copyCanRecover = canInspect || canOpenFlow;
  const compactCopyClass = cn(
    'min-w-0 truncate',
    !copyCanRecover &&
      '@max-[30rem]:overflow-visible @max-[30rem]:whitespace-normal @max-[30rem]:text-clip @max-[30rem]:wrap-anywhere',
  );
  return (
    <div
      className="grid w-full min-w-0 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 px-4 py-2.5 @max-[30rem]:grid-cols-[18px_minmax(0,1fr)]"
      data-slot="flow-change-receipt"
    >
      <span
        className={cn(
          'grid size-[18px] place-items-center self-start',
          PHASE_ACCENT_CLASS[presentation.phase],
        )}
        aria-hidden="true"
      >
        <PhaseIcon className="size-[15px]" />
      </span>

      <div className="flex min-w-0 flex-col gap-0.5" data-slot="flow-change-copy">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'shrink-0 text-[10px] font-semibold leading-[15px]',
              PHASE_ACCENT_CLASS[presentation.phase],
            )}
          >
            {status}
          </span>
          <h3
            className={cn(
              'm-0 min-w-0 text-sm font-semibold leading-[18px] text-foreground',
              compactCopyClass,
            )}
            id={titleId}
          >
            {presentation.name}
          </h3>
        </div>

        <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground">
          <p className={cn('m-0 text-[11px] leading-4', compactCopyClass)}>{summary}</p>
          {metadata ? (
            <p
              className={cn(
                'm-0 shrink-0 border-l border-border/60 pl-2 text-[10px] leading-[15px]',
                !copyCanRecover && '@max-[30rem]:shrink @max-[30rem]:border-l-0 @max-[30rem]:pl-0',
              )}
            >
              {metadata}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 @max-[30rem]:col-start-2 @max-[30rem]:justify-self-end">
        {canInspect ? (
          <ChangeToggle
            detailsId={detailsId}
            expanded={expanded}
            name={presentation.name}
            onToggle={onToggle}
            phaseLabel={status}
            summary={summary}
          />
        ) : null}

        {presentation.flowId && onOpenFlow ? (
          <OpenFlowAction
            flowId={presentation.flowId}
            name={presentation.name}
            onOpenFlow={onOpenFlow}
            phaseLabel={status}
            summary={summary}
            withTooltip={!canInspect}
          />
        ) : null}
      </div>
    </div>
  );
});
