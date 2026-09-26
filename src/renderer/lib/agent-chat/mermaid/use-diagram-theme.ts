import { useEffect, useState } from 'react';
import { type DiagramTheme, readDiagramTheme } from './mermaid-config';

function sameTheme(a: DiagramTheme, b: DiagramTheme): boolean {
  return Object.values(a).join() === Object.values(b).join();
}

/**
 * The active diagram theme. Every Frink theme change (appearance, palette, contrast, editor
 * preview) rewrites <html>'s class or inline vars, so it is re-read on exactly those mutations.
 */
export function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState(readDiagramTheme);

  useEffect(() => {
    const sync = () => {
      const next = readDiagramTheme();
      setTheme((prev) => (sameTheme(prev, next) ? prev : next));
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    // Catches a change that landed between the first read and the observer attaching.
    sync();
    return () => observer.disconnect();
  }, []);

  return theme;
}
