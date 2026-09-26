import type { ReactElement } from 'react';
import { cn } from '../../../lib/utils';
import type { ResizeHandleProps } from './types';

export function ResizeHandle({
  onPointerDown,
  onMouseEnter,
  onMouseLeave,
  style,
  interactionDisabled = false,
}: ResizeHandleProps): ReactElement {
  return (
    <button
      type="button"
      data-resize-chrome
      aria-label="Resize sidebar"
      aria-disabled={interactionDisabled}
      tabIndex={interactionDisabled ? -1 : 0}
      className={cn(
        'absolute top-0 bottom-0 cursor-col-resize border-0 bg-transparent p-0',
        interactionDisabled && 'pointer-events-none',
      )}
      onPointerDown={onPointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={style}
    />
  );
}
