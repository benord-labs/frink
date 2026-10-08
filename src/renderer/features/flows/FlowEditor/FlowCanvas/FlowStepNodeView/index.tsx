/* eslint-disable max-lines, max-lines-per-function */
/**
 * Presentational flow step card (React Flow custom node).
 */

import { Button } from '@benord-labs/frink-primitives';
import { Handle, NodeResizer, NodeToolbar, Position } from '@xyflow/react';
import { useAtomValue } from 'jotai';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Trash2, XCircle } from 'lucide-react';
import { type MouseEvent, type ReactElement, useState } from 'react';
import type { FlowNode as FlowNodeDef } from '../../../../../../shared/lib/validate-flow-graph';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { ghostExecAtomFamily, ghostRunActiveAtom } from '../../../../../lib/flow-rehearsal';
import { nodeExecAtomFamily } from '../../../atoms';
import { LoopIterationBadge } from '../../../LoopIterationBadge';
import { FlowBlockTile } from '../../FlowBlockIcon';
import {
  type FlowNodeCanvasContext,
  flowNodeNeedsAttention,
  flowNodeNeedsProject,
  flowNodeSummaryLine,
  flowStepIdentity,
} from '../../nodeSummary';
import { FlowStepAddHandle } from '../FlowStepAddHandle';
import { blockHeaderTintClass } from '../flowStepNodeStyles';
import { cn } from '../../../../../lib/utils';

/** Steps whose summary is a command or expression, so it reads in the code face. */
const LITERAL_SUMMARY_TYPES = new Set(['run_command', 'condition', 'http_request']);

/** No transform on hover — RF centers handles via `transform`; `scale` overrides it and shifts the hit target. */
const HANDLE_CLASS =
  "h-2.5! w-2.5! min-h-0! min-w-0! border-2! border-card! transition-[opacity,box-shadow] hover:ring-2 hover:ring-primary/40 after:absolute after:-inset-2 after:content-['']";

type FlowStepNodeViewProps = {
  node: FlowNodeDef;
  index: number;
  isTrigger: boolean;
  isCondition: boolean;
  isEnd: boolean;
  graphLength: number;
  isSelected: boolean;
  showAppendStubDefault: boolean;
  showAppendStubTrue: boolean;
  showAppendStubFalse: boolean;
  customBlockIcon?: string;
  customFlowCanvasContext?: FlowNodeCanvasContext;
  flowDefaultProjectId?: string;
  /** Scopes canvas execution overlay to the correct flow. */
  flowId?: string;
  /** When true, execution chrome is muted (run history inspection). */
  canvasHistoricalInspection?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRequestAddStep: (sourceHandle: string | undefined) => void;
  /** Deep-link from the missing-project warning to the flow settings Project field. */
  onRequestOpenFlowSettings?: () => void;
  /** When true: hides toolbar + add-step stubs; keeps Handles mounted (opacity-0) for edge anchoring. */
  readOnly?: boolean;
  /** Fan Out only: resize floor, so the container can never be shrunk over its children. */
  fanOutMinSize?: { width: number; height: number };
};

export function FlowStepNodeView({
  node,
  index,
  isTrigger,
  isCondition,
  isEnd,
  graphLength,
  isSelected,
  showAppendStubDefault,
  showAppendStubTrue,
  showAppendStubFalse,
  customBlockIcon,
  customFlowCanvasContext,
  flowDefaultProjectId,
  flowId,
  canvasHistoricalInspection = false,
  onSelect,
  onDelete,
  onRequestAddStep,
  onRequestOpenFlowSettings,
  readOnly = false,
  fanOutMinSize,
}: FlowStepNodeViewProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const execKey = flowId ? `${flowId}:${node.id}` : `__none__:${node.id}`;
  const execState = useAtomValue(nodeExecAtomFamily(execKey));
  // Ghost Run overlay: while a rehearsal is active, the canvas paints predicted state from a
  // parallel atom family instead of the live one. When inactive these reads are null and the
  // node renders byte-for-byte as before.
  const ghostRunActive = useAtomValue(ghostRunActiveAtom);
  const ghostState = useAtomValue(ghostExecAtomFamily(execKey));
  // Live exec state drives the loop-iteration badge (a live-run-only concept). Ghost rehearsals
  // never carry loop info, so the badge stays a pure live-run signal.
  const liveExecState = flowId ? execState : null;
  // While a rehearsal is active the canvas shows the static-analysis verdict from a parallel atom
  // family; otherwise it shows the live run state. The two are rendered through distinct branches
  // (different status vocabularies + ghost carries explainable findings).
  const activeGhost = flowId && ghostRunActive ? ghostState : null;
  const activeExecState = flowId && !ghostRunActive ? execState : null;
  const ghostFindings = activeGhost?.findings ?? [];

  const { name: displayLabel, kind: typeLabel } = flowStepIdentity(node);
  const needsAttention = flowNodeNeedsAttention(
    node,
    flowDefaultProjectId,
    customFlowCanvasContext,
  );
  const summary = flowNodeSummaryLine(node, flowDefaultProjectId, customFlowCanvasContext);
  const showToolbar = !readOnly && (hovered || isSelected) && !isTrigger;
  // Missing project resolves flow-wide (settings default), so the warning deep-links there
  // instead of sending the user to fix each node individually.
  const showSetProjectCta =
    !readOnly &&
    !activeExecState &&
    !activeGhost &&
    onRequestOpenFlowSettings !== undefined &&
    flowNodeNeedsProject(node, flowDefaultProjectId);
  const openFlowSettings = (e: MouseEvent) => {
    e.stopPropagation();
    onRequestOpenFlowSettings?.();
  };

  // Ghost paint: a node with no findings stays a neutral "looks ready" ghost; an error finding
  // paints crimson-ghost, a warn/info finding paints amber-ghost. No findings is the clean default.
  const ghostClass = activeGhost
    ? activeGhost.status === 'failed'
      ? 'flow-node-ghost-failed'
      : activeGhost.status === 'warn'
        ? 'flow-node-ghost-warn'
        : 'flow-node-ghost-clean'
    : '';

  const liveClass =
    activeExecState?.status === 'running'
      ? 'flow-node-running'
      : activeExecState?.status === 'completed'
        ? 'flow-node-completed'
        : activeExecState?.status === 'failed'
          ? 'flow-node-failed'
          : activeExecState?.status === 'skipped'
            ? 'flow-node-skipped'
            : activeExecState?.status === 'awaiting_input'
              ? 'flow-node-awaiting-input'
              : activeExecState?.status === 'blocked'
                ? 'flow-node-blocked'
                : '';

  const execClass = activeGhost ? ghostClass : liveClass;
  // Edges carry the connections at rest; a step's handles appear once it is hovered or selected.
  const handleVisibility = readOnly
    ? ' opacity-0! pointer-events-none!'
    : hovered || isSelected
      ? ''
      : ' opacity-0';
  const isFanOut = node.blockType === 'fan_out';

  // The single highest-severity node in the rehearsal gets the crimson at-risk halo.
  const riskClass = activeGhost?.isAtRisk ? 'flow-node-at-risk' : '';

  const historicalChromeClass =
    canvasHistoricalInspection && activeExecState ? 'flow-node-exec-historical' : '';

  return (
    <div
      className={`relative ${isFanOut ? 'flex h-full flex-col items-center rounded-2xl border border-primary/25 bg-primary/5 p-4' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isFanOut && !readOnly && fanOutMinSize ? (
        // Every border and corner resizes, like any card; styling lives in flowCanvasChrome.css.
        <NodeResizer
          minWidth={fanOutMinSize.width}
          minHeight={fanOutMinSize.height}
          lineClassName="flow-fanout-resize-line"
          handleClassName="flow-fanout-resize-corner"
        />
      ) : null}

      <NodeToolbar
        isVisible={showToolbar}
        position={Position.Top}
        align="end"
        offset={6}
        className="flex rounded-lg border border-border/70 bg-card p-0.5 shadow-lg shadow-black/20"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 text-muted-foreground hover:text-destructive"
          aria-label="Delete step"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          iconOnly
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </NodeToolbar>

      {!isTrigger ? (
        <Handle
          type="target"
          position={Position.Top}
          title="Drag from another step's output to connect"
          className={`${HANDLE_CLASS} !bg-muted-foreground/70${handleVisibility}`}
        />
      ) : null}

      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={`flow-step-node-card flex w-[320px] cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[inset_1px_1px_0_0_rgb(255_255_255/0.06),0_1px_2px_0_rgb(0_0_0/0.12),0_8px_20px_-12px_rgb(0_0_0/0.4)] outline-hidden transition-[border-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/40 ${
          isSelected
            ? 'border-primary/70 ring-[3px] ring-primary/20'
            : 'border-border/70 hover:border-muted-foreground/40'
        } ${execClass} ${riskClass} ${historicalChromeClass}`}
        aria-pressed={isSelected}
        aria-label={`Step ${index + 1}: ${displayLabel}`}
      >
        <div
          className={cn(
            'flex items-center gap-2.5 px-3 py-2.5',
            blockHeaderTintClass(node.blockType),
          )}
        >
          <FlowBlockTile type={node.blockType} customBlockIcon={customBlockIcon} compact>
            {needsAttention && !activeExecState && !activeGhost ? (
              showSetProjectCta ? (
                // eslint-disable-next-line no-restricted-syntax -- bespoke 10px warning dot; ui Button sizing/variants fight the absolutely-positioned badge
                <button
                  type="button"
                  onClick={openFlowSettings}
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 cursor-pointer rounded-full border-2 border-card bg-amber-600 outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:bg-amber-500"
                  aria-label="Set flow default project"
                  title="No project — set the flow default project"
                />
              ) : (
                <span
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-amber-600 dark:bg-amber-500"
                  aria-hidden
                  title="Incomplete configuration"
                />
              )
            ) : null}
            {/* Rehearsal finding badge: hover lists this node's findings (why + fix). */}
            {ghostFindings.length > 0 ? (
              <Tooltip>
                {/* Hover-only tooltip; the same why/fix is keyboard-reachable via the findings
                    panel rows in GhostRunHeaderStrip, so the badge stays a non-interactive img. */}
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    className={`absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-card ${
                      activeGhost?.status === 'failed' ? 'bg-destructive' : 'bg-amber-500'
                    }`}
                    aria-label={`${ghostFindings.length} rehearsal ${ghostFindings.length === 1 ? 'finding' : 'findings'}`}
                  >
                    {activeGhost?.status === 'failed' ? (
                      <AlertCircle
                        className="h-2.5 w-2.5 text-destructive-foreground"
                        aria-hidden
                      />
                    ) : (
                      <AlertTriangle className="h-2.5 w-2.5 text-white" aria-hidden />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <ul className="space-y-1.5">
                    {ghostFindings.map((f) => (
                      <li key={`${f.nodeId}:${f.rule}`} className="text-xs">
                        <span className="font-medium">{f.why}</span>
                        <span className="block text-muted-foreground">{f.fix}</span>
                      </li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            ) : null}
            {activeExecState?.status === 'running' ? (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full border-2 border-card bg-primary"
                aria-hidden
              >
                <Loader2 className="h-2 w-2 animate-spin text-primary-foreground" />
              </span>
            ) : activeExecState?.status === 'completed' ? (
              <span
                className="absolute -right-0.5 -bottom-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-card bg-emerald-500"
                aria-hidden
              >
                <CheckCircle2 className="h-2.5 w-2.5 text-white" />
              </span>
            ) : activeExecState?.status === 'failed' ? (
              <span
                className="absolute -right-0.5 -bottom-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-card bg-destructive"
                aria-hidden
              >
                <XCircle className="h-2.5 w-2.5 text-destructive-foreground" />
              </span>
            ) : null}
          </FlowBlockTile>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {displayLabel}
          </p>
          {typeLabel !== displayLabel ? (
            <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">
              {typeLabel}
            </span>
          ) : null}
          {liveExecState?.loopIteration != null ? (
            <LoopIterationBadge
              loopIteration={liveExecState.loopIteration}
              loopTotalCount={liveExecState.loopTotalCount}
              variant="canvas"
            />
          ) : null}
        </div>
        {summary !== displayLabel || showSetProjectCta ? (
          <div className="flex flex-col items-start gap-1 border-t border-border/50 px-3 py-2.5">
            {summary !== displayLabel ? (
              <p
                className={cn(
                  'w-full truncate text-sm text-muted-foreground',
                  LITERAL_SUMMARY_TYPES.has(node.blockType) && 'font-mono text-xs leading-5',
                )}
                title={summary}
              >
                {summary}
              </p>
            ) : null}
            {showSetProjectCta ? (
              <Button
                type="button"
                variant="ghost"
                onClick={openFlowSettings}
                className="h-auto p-0 text-sm text-warning underline-offset-2 hover:underline focus-visible:underline"
              >
                Set flow default project
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {isFanOut ? (
        <p className="mt-6 self-stretch pl-[calc(50%+10px)] text-xs text-primary/80">
          For each item
        </p>
      ) : null}

      {isCondition ? (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="true"
            title="Drag to connect the True branch"
            style={{ left: '35%' }}
            className={`${HANDLE_CLASS} !bg-emerald-500${handleVisibility}`}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="false"
            title="Drag to connect the False branch"
            style={{ left: '65%' }}
            className={`${HANDLE_CLASS} !bg-rose-500${handleVisibility}`}
          />
          {!readOnly && (
            <div className="pointer-events-auto absolute left-0 top-full mt-2 flex w-full justify-between px-8">
              {showAppendStubTrue ? (
                <FlowStepAddHandle
                  graphLength={graphLength}
                  sourceHandle="true"
                  onRequestAddStep={onRequestAddStep}
                />
              ) : (
                <span className="w-8 shrink-0" aria-hidden />
              )}
              {showAppendStubFalse ? (
                <FlowStepAddHandle
                  graphLength={graphLength}
                  sourceHandle="false"
                  onRequestAddStep={onRequestAddStep}
                />
              ) : (
                <span className="w-8 shrink-0" aria-hidden />
              )}
            </div>
          )}
        </>
      ) : isEnd ? null : (
        <>
          <Handle
            type="source"
            position={isFanOut ? Position.Top : Position.Bottom}
            id="out"
            title="Drag to connect to another step"
            style={isFanOut ? { top: 136 } : undefined}
            className={`${HANDLE_CLASS} !bg-muted-foreground/70${handleVisibility}`}
          />
          {!readOnly && showAppendStubDefault ? (
            <div
              className={`pointer-events-auto absolute left-1/2 flex -translate-x-1/2 ${isFanOut ? '' : 'top-full mt-2'}`}
              style={isFanOut ? { top: 144 } : undefined}
            >
              <FlowStepAddHandle
                graphLength={graphLength}
                sourceHandle={undefined}
                onRequestAddStep={onRequestAddStep}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
