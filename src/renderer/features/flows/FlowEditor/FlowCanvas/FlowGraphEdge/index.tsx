/* eslint-disable max-lines, max-lines-per-function */
/**
 * Bezier edge with branch label, animated stroke, and insert control at midpoint on hover/selection.
 * The (+) opens the node creator to insert a step on this edge (split connection).
 * Back-edges (loop-backs from condition nodes) render with a distinct dashed style + loop badge.
 */

import { Button } from '@benord-labs/frink-primitives';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { Plus, RotateCcw } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BACK_EDGE_CLEARANCE } from '../../../../../../shared/lib/flows/canvas-layout/constants';
import { EdgeRemoveControl } from '../../EdgeRemoveControl';

const HOVER_LEAVE_MS = 180;

const EDGE_LABEL_CLASS =
  'nodrag nopan pointer-events-none flex items-center gap-1 rounded-full border border-border/70 bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground';

// Back-edge routing: "true" loops LEFT, "false" loops RIGHT so they're visually distinct.
const BE_R = 10;
const BE_STEP = 8;
const BE_TOP = 20;
const BE_CLEARANCE = BACK_EDGE_CLEARANCE;
/** Nudge branch text + loop badge up from the geometric label anchor (screen Y increases downward). */
const BE_LABEL_BADGE_OFFSET = -20;

function buildBackEdgePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  side: 'left' | 'right',
): { path: string; labelX: number; labelY: number } {
  const r = BE_R;
  const step = BE_STEP;
  const top = Math.min(BE_TOP, Math.max(r + 2, (sy - ty - step) / 3));
  const dir = side === 'left' ? -1 : 1;
  const stemX = tx + dir * BE_CLEARANCE;

  const path = [
    `M ${sx} ${sy}`,
    `L ${sx} ${sy + step - r}`,
    `Q ${sx} ${sy + step} ${sx + dir * r} ${sy + step}`,
    `L ${stemX - dir * r} ${sy + step}`,
    `Q ${stemX} ${sy + step} ${stemX} ${sy + step - r}`,
    `L ${stemX} ${ty - top + r}`,
    `Q ${stemX} ${ty - top} ${stemX - dir * r} ${ty - top}`,
    `L ${tx + dir * r} ${ty - top}`,
    `Q ${tx} ${ty - top} ${tx} ${ty - top + r}`,
    `L ${tx} ${ty}`,
  ].join(' ');

  return {
    path,
    labelX: stemX,
    labelY: (sy + ty) / 2,
  };
}

export type FlowGraphEdgeData = {
  onInsert?: () => void;
  onDelete?: () => void;
  isBackEdge?: boolean;
  loopMaxIterations?: number;
};

export function FlowGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  style,
  markerEnd,
  selected,
  label,
  data,
}: EdgeProps): ReactElement {
  const d = data as FlowGraphEdgeData | undefined;
  const isBackEdge = d?.isBackEdge === true;
  const [hovered, setHovered] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimerRef.current !== null) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const setHoverPinned = useCallback(
    (next: boolean) => {
      clearLeaveTimer();
      setHovered(next);
    },
    [clearLeaveTimer],
  );

  const scheduleHoverOff = useCallback(() => {
    clearLeaveTimer();
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      setHovered(false);
      setPendingDelete(false);
    }, HOVER_LEAVE_MS);
  }, [clearLeaveTimer]);

  useEffect(() => () => clearLeaveTimer(), [clearLeaveTimer]);

  // When the edge is deselected (e.g. user clicks elsewhere), dismiss any
  // pending confirmation so it doesn't linger in a stale visible state.
  useEffect(() => {
    if (!selected) setPendingDelete(false);
  }, [selected]);

  const backEdgeSide: 'left' | 'right' = sourceHandleId === 'false' ? 'right' : 'left';

  const [edgePath, labelX, labelY] = useMemo(() => {
    if (isBackEdge) {
      const {
        path,
        labelX: lx,
        labelY: ly,
      } = buildBackEdgePath(sourceX, sourceY, targetX, targetY, backEdgeSide);
      return [path, lx, ly] as const;
    }
    return getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }, [
    isBackEdge,
    sourceX,
    sourceY,
    targetX,
    targetY,
    backEdgeSide,
    sourcePosition,
    targetPosition,
  ]);

  const hasLabel = Boolean(label);
  const showControls = (hovered || selected || pendingDelete) && (d?.onInsert || d?.onDelete);

  const maxIter = d?.loopMaxIterations;
  const loopTooltip = isBackEdge
    ? `Loop back${maxIter != null ? ` — max ${maxIter} iteration${maxIter === 1 ? '' : 's'}` : ''}`
    : undefined;

  return (
    <g onMouseEnter={() => setHoverPinned(true)} onMouseLeave={() => scheduleHoverOff()}>
      <BaseEdge
        id={id}
        path={edgePath}
        style={isBackEdge ? { ...style, strokeDasharray: '5 5' } : style}
        markerEnd={markerEnd}
        className="react-flow__edge-path"
        interactionWidth={28}
      />
      {isBackEdge || hasLabel ? (
        <EdgeLabelRenderer>
          <div
            className={EDGE_LABEL_CLASS}
            style={{
              position: 'absolute',
              // A loop's pill hangs outside its lane, so it never sits on the cards it detours around.
              transform: isBackEdge
                ? `translate(${backEdgeSide === 'right' ? '10px' : 'calc(-100% - 10px)'}, -50%) translate(${labelX}px,${labelY + BE_LABEL_BADGE_OFFSET}px)`
                : `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
            title={loopTooltip}
          >
            {isBackEdge ? <RotateCcw className="size-3" aria-hidden /> : null}
            {isBackEdge ? 'Loop' : null}
            {isBackEdge && hasLabel ? ' · ' : null}
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {showControls ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan flex items-center gap-0.5 rounded-lg border border-border/70 bg-card p-0.5 shadow-lg shadow-black/30"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              // EdgeLabelRenderer portal layer defaults to ignoring pointer events.
              pointerEvents: 'all',
            }}
            onMouseEnter={() => setHoverPinned(true)}
            onMouseLeave={() => scheduleHoverOff()}
          >
            {d?.onInsert ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-[5px] text-muted-foreground hover:text-foreground"
                aria-label="Insert step on this connection"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  d.onInsert?.();
                }}
                iconOnly
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
            {d?.onDelete ? (
              <EdgeRemoveControl
                noun="connection"
                pending={pendingDelete}
                onPendingChange={setPendingDelete}
                onConfirm={() => d.onDelete?.()}
              />
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
