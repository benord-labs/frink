import { useCallback, useRef } from 'react';

export function useCanvasUrlCache() {
  const cache = useRef(new WeakMap<HTMLCanvasElement, string>());

  const toUrl = useCallback((canvas: HTMLCanvasElement) => {
    let url = cache.current.get(canvas);
    if (!url) {
      url = canvas.toDataURL();
      cache.current.set(canvas, url);
    }
    return url;
  }, []);

  return toUrl;
}
