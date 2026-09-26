import { useCallback, useEffect, useState } from 'react';
import { cachedDiagram, DiagramSourceError, renderDiagram } from './render-diagram';
import { useDiagramTheme } from './use-diagram-theme';

export type DiagramState =
  | { status: 'drawing' }
  | { status: 'ready'; svg: string }
  /** `invalid`: Mermaid could not read the source. Otherwise loading or drawing failed. */
  | { status: 'error'; message: string; invalid: boolean };

/** The latest result, tagged with the source it belongs to. */
type Drawn = { code: string; state: DiagramState };

const DRAWING: DiagramState = { status: 'drawing' };
// While streaming, wait for the source to stop changing before paying for a parse.
const STREAMING_DEBOUNCE_MS = 600;

/** A result shows only for its own source; while streaming, the last good drawing stays up. */
function visibleState(drawn: Drawn, code: string, isStreaming: boolean): DiagramState {
  if (drawn.code === code) return drawn.state;
  return isStreaming && drawn.state.status === 'ready' ? drawn.state : DRAWING;
}

/**
 * The diagram for `code` in the active Frink theme, plus a retry for failed draws. While
 * streaming, source Mermaid cannot parse yet keeps the last good drawing (or "drawing").
 */
export function useMermaidDiagram(
  code: string,
  isStreaming: boolean,
): [state: DiagramState, retry: () => void] {
  const theme = useDiagramTheme();
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState<Drawn>(() => {
    const svg = cachedDiagram(code, theme);
    return { code, state: svg ? { status: 'ready', svg } : DRAWING };
  });

  useEffect(() => {
    let current = true;
    const draw = async () => {
      try {
        const svg = await renderDiagram(code, theme);
        if (current) setDrawn({ code, state: { status: 'ready', svg } });
      } catch (error) {
        const invalid = error instanceof DiagramSourceError;
        // Mid-stream source that does not parse yet is expected: keep what is showing.
        if (!current || (isStreaming && invalid)) return;
        const message = error instanceof Error ? error.message : String(error);
        setDrawn({ code, state: { status: 'error', message, invalid } });
      }
    };
    const timer = setTimeout(() => void draw(), isStreaming ? STREAMING_DEBOUNCE_MS : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code, isStreaming, theme, attempt]);

  const retry = useCallback(() => {
    setDrawn({ code, state: DRAWING });
    setAttempt((count) => count + 1);
  }, [code]);

  return [visibleState(drawn, code, isStreaming), retry];
}
