import type { ReactElement } from 'react';
import type { ExtendedHoverAreaProps } from './types';

export function ExtendedHoverArea({
  isResizing,
  onPointerDown,
  onMouseEnter,
  onMouseLeave,
  style,
  interactionDisabled = false,
}: ExtendedHoverAreaProps): ReactElement {
  const pointerEvents = interactionDisabled ? 'none' : isResizing ? 'none' : 'auto';
  return (
    <div
      data-extended-hover-area
      data-resize-chrome
      aria-hidden="true"
      className="absolute top-0 bottom-0 cursor-col-resize border-0 bg-transparent p-0"
      style={{
        ...style,
        pointerEvents,
        zIndex: isResizing ? 5 : 10,
      }}
      onPointerDown={onPointerDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}
