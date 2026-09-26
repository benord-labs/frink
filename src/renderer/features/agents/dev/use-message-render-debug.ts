import { useRef } from 'react';

const STORAGE_KEY = 'agents:debugRenders';

/**
 * Opt-in render tracing for multi-pane perf: in dev, run
 * `localStorage.setItem('agents:debugRenders', '1')` then compare **non-streaming** vs **streaming**
 * lane logs while one chat streams. Remove with `localStorage.removeItem('agents:debugRenders')`.
 */
export function useMessageRenderDebug(
  lane: 'streaming' | 'non-streaming',
  messageId: string,
): void {
  const countRef = useRef(0);
  countRef.current += 1;
  if (
    !import.meta.env.DEV ||
    typeof localStorage === 'undefined' ||
    localStorage.getItem(STORAGE_KEY) !== '1'
  ) {
    return;
  }
  // biome-ignore lint/suspicious/noConsole: opt-in localStorage-gated multi-pane render tracing
  console.debug(`[agents:render] ${lane} id=${messageId} #${countRef.current}`);
}
