import type { Rectangle } from 'electron';
import type { ViewRect } from '../../../shared/types/browser';

// Shared by every main-owned native view placed over a DOM slot (HTML artifacts, browser pages).

export type NativeViewSender = { isDestroyed(): boolean; mainFrame: object };
export type NativeViewIpcEvent<S extends NativeViewSender> = {
  sender: S;
  senderFrame: object | null;
};
export type NativeViewOwner<S extends NativeViewSender> = {
  isDestroyed(): boolean;
  webContents: S;
};

/** CSS-px slot bounds scaled by the renderer zoom, clamped inside the host's content area. */
export function scaleViewBounds(
  bounds: ViewRect,
  zoom: number,
  content: Pick<Rectangle, 'width' | 'height'>,
): Rectangle {
  const x = Math.min(Math.max(0, Math.round(bounds.x * zoom)), Math.max(0, content.width - 1));
  const y = Math.min(Math.max(0, Math.round(bounds.y * zoom)), Math.max(0, content.height - 1));
  const width = Math.max(1, Math.min(Math.round(bounds.width * zoom), content.width - x));
  const height = Math.max(1, Math.min(Math.round(bounds.height * zoom), content.height - y));
  return { x, y, width, height };
}

/** Throws unless the IPC came from the main frame of the expected host window's own renderer;
 * `senderHost` is the window that owns the sender. */
export function assertMainFrameSender<S extends NativeViewSender, H extends NativeViewOwner<S>>(
  event: NativeViewIpcEvent<S>,
  expected: H | null,
  senderHost: H | null,
  label: string,
): H {
  const { sender, senderFrame } = event;
  if (sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame) {
    throw new Error(`${label} requires the main renderer frame`);
  }
  if (
    !expected ||
    expected.isDestroyed() ||
    senderHost !== expected ||
    expected.webContents !== sender
  ) {
    throw new Error(`${label} owner window is unavailable`);
  }
  return expected;
}
