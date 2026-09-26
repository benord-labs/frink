/**
 * Shared canvas controls bar used across all React Flow canvases in the flow editor.
 * Renders a fit-view button and any additional control buttons passed as children.
 */
import { ControlButton, Controls } from '@xyflow/react';
import { Maximize2 } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

type CanvasControlsProps = {
  onFitView: () => void;
  /** Additional control buttons rendered after the fit-view button. */
  children?: ReactNode;
};

export function CanvasControls({ onFitView, children }: CanvasControlsProps): ReactElement {
  return (
    <Controls className="border-border! bg-card! shadow-md!" showInteractive={false}>
      <ControlButton onClick={onFitView} title="Fit view" aria-label="Fit view">
        <Maximize2 className="h-3.5 w-3.5" aria-hidden />
      </ControlButton>
      {children}
    </Controls>
  );
}
