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

/** React Flow paints the bar from its --xy-controls-* variables, so the pill restyles through them. */
const CONTROLS_CLASS = [
  'glass-float gap-0.5 rounded-xl border border-border/60 p-1',
  '[--xy-controls-box-shadow:var(--glass-rim-shadow),0_8px_24px_-8px_rgb(0_0_0/0.5)]',
  '[--xy-controls-button-background-color:transparent]',
  '[--xy-controls-button-background-color-hover:hsl(var(--foreground)/0.07)]',
  '[--xy-controls-button-color:var(--color-muted-foreground)]',
  '[--xy-controls-button-color-hover:var(--color-foreground)]',
  '[--xy-controls-button-border-color:transparent]',
  '[&_.react-flow__controls-button]:size-7! [&_.react-flow__controls-button]:rounded-md!',
].join(' ');

export function CanvasControls({ onFitView, children }: CanvasControlsProps): ReactElement {
  return (
    <Controls
      className={CONTROLS_CLASS}
      orientation="horizontal"
      showFitView={false}
      showInteractive={false}
    >
      <ControlButton onClick={onFitView} title="Fit view" aria-label="Fit view">
        <Maximize2 className="h-3.5 w-3.5" aria-hidden />
      </ControlButton>
      {children}
    </Controls>
  );
}
