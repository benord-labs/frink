/**
 * Bezier connection preview while dragging a new edge.
 */

import { type ConnectionLineComponentProps, getBezierPath } from '@xyflow/react';
import type { ReactElement } from 'react';

export function FlowConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionLineStyle,
}: ConnectionLineComponentProps): ReactElement {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  return (
    <g>
      <path
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
        strokeOpacity={0.85}
        d={path}
        className="animated"
        style={connectionLineStyle}
      />
    </g>
  );
}
