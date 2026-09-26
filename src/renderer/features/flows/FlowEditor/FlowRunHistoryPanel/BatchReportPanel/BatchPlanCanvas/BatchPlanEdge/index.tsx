/**
 * Custom React Flow edge for the batch DAG plan canvas.
 *
 * Simplified version of FlowGraphEdge — no insert button, no back-edge routing.
 * Shows an inline delete confirmation on hover/select (same pendingDelete pattern
 * as FlowGraphEdge to keep UX consistent).
 *
 * data.editable — hides delete controls when false (edge targets a non-pending stage).
 * data.onDelete — called when the user confirms deletion.
 */

import { Button } from '@benord-labs/frink-primitives';
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';
import { Check, X } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

const HOVER_LEAVE_MS = 180;

export type BatchPlanEdgeData = {
  onDelete?: () => void;
  editable?: boolean;
};

/** Full edge type for this component — `EdgeProps` is parameterized by `Edge`, not `data` alone. */
type BatchPlanEdgeType = Edge<BatchPlanEdgeData>;

export function BatchPlanEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
  data,
}: EdgeProps<BatchPlanEdgeType>): ReactElement {
  const isEditable = data?.editable !== false;

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

  // When edge is deselected, dismiss any pending confirmation.
  useEffect(() => {
    if (!selected) setPendingDelete(false);
  }, [selected]);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const showControls = (hovered || selected || pendingDelete) && isEditable && data?.onDelete;

  return (
    <g onMouseEnter={() => setHoverPinned(true)} onMouseLeave={() => scheduleHoverOff()}>
      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        markerEnd={markerEnd}
        className="react-flow__edge-path"
        interactionWidth={28}
      />
      {showControls ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan flex items-center gap-0.5 rounded-md border border-border bg-card shadow-md"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            onMouseEnter={() => setHoverPinned(true)}
            onMouseLeave={() => scheduleHoverOff()}
          >
            {pendingDelete ? (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex items-center gap-0.5"
              >
                <span className="px-1.5 text-[11px] text-muted-foreground select-none">
                  Remove?
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 rounded-[5px] text-destructive hover:text-destructive"
                  aria-label="Confirm remove dependency"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(false);
                    data?.onDelete?.();
                  }}
                  iconOnly
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 rounded-[5px] text-muted-foreground hover:text-foreground"
                  aria-label="Cancel remove dependency"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(false);
                  }}
                  iconOnly
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-[5px] text-muted-foreground hover:text-destructive"
                aria-label="Remove this dependency"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(true);
                }}
                iconOnly
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
