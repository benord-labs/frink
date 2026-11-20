type ZoomableContents = {
  on(event: 'did-navigate-in-page', listener: () => void): void;
  setZoomFactor(factor: number): void;
};

/**
 * Applies the app zoom now and again after each in-page navigation. Chromium keys a file:// page's
 * zoom by its whole URL, query included, so a new `?chat=` URL would otherwise report 100%.
 */
export function keepAppZoom(contents: ZoomableContents, zoom: () => number): void {
  const apply = () => contents.setZoomFactor(zoom());
  apply();
  contents.on('did-navigate-in-page', apply);
}
