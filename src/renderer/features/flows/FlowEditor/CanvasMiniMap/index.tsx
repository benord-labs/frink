/**
 * Shared MiniMap component used across React Flow canvases in the flow editor.
 * Handles shared chrome (className, pannable, zoomable); nodeColor is domain-specific.
 */
import { MiniMap, type Node } from '@xyflow/react';
import type { ReactElement } from 'react';

type CanvasMiniMapProps = {
  nodeColor: (node: Node) => string;
  maskColor?: string;
};

const DEFAULT_MASK_COLOR = 'hsl(var(--background) / 0.5)';

export function CanvasMiniMap({
  nodeColor,
  maskColor = DEFAULT_MASK_COLOR,
}: CanvasMiniMapProps): ReactElement {
  return (
    <MiniMap
      className="border-border! bg-card/95!"
      nodeColor={nodeColor}
      maskColor={maskColor}
      pannable
      zoomable
    />
  );
}
