import {
  EXTENDED_HOVER_AREA_WIDTH,
  RESIZE_HANDLE_OFFSET_PX,
  RESIZE_HANDLE_PADDING_PX,
  RESIZE_HANDLE_WIDTH_PX,
} from './constants';
import type { Side } from './types';

export const calculateResizeHandleStyle = (side: Side) => {
  const baseStyle = {
    width: `${RESIZE_HANDLE_WIDTH_PX}px`,
    paddingLeft: `${RESIZE_HANDLE_PADDING_PX}px`,
    paddingRight: `${RESIZE_HANDLE_PADDING_PX}px`,
  };

  if (side === 'left') {
    return {
      ...baseStyle,
      right: '0px',
      marginRight: `${RESIZE_HANDLE_OFFSET_PX}px`,
    };
  }

  return {
    ...baseStyle,
    left: '0px',
    marginLeft: `${RESIZE_HANDLE_OFFSET_PX}px`,
  };
};

export const calculateExtendedHoverAreaStyle = (side: Side) => {
  const width = `${EXTENDED_HOVER_AREA_WIDTH}px`;

  if (side === 'left') {
    return { width, right: '0px' };
  }

  return { width, left: '0px' };
};

export const clampWidth = (width: number, minWidth: number, maxWidth: number) =>
  Math.max(minWidth, Math.min(maxWidth, width));

export const calculateDelta = (currentX: number, startX: number, side: Side) => {
  return side === 'left' ? currentX - startX : startX - currentX;
};
