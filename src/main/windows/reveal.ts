interface RevealableWindow {
  once(event: 'ready-to-show', listener: () => void): void;
  isDestroyed(): boolean;
  webContents: { once(event: 'did-finish-load', listener: () => void): void };
}

/**
 * Runs `reveal` once for a window created with `show: false`. On Linux, Electron 38+ never emits
 * `ready-to-show` for a hidden Wayland window (electron/electron#48859), so `did-finish-load` also counts.
 */
export function revealWhenReady(
  window: RevealableWindow,
  reveal: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  let revealed = false;
  const revealOnce = (): void => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    reveal();
  };
  window.once('ready-to-show', revealOnce);
  if (platform === 'linux') window.webContents.once('did-finish-load', revealOnce);
}
