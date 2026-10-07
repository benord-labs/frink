/** A running command's runtime and latest output, on either provider, pulled every second only while
 * it is on screen. Renders nothing for a command main has no output for. */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { formatElapsedTime } from '../../../../lib/agent-chat/elapsed-time/format-elapsed-time';
import { trpc } from '../../../../lib/trpc';

const POLL_MS = 1000;

export function CommandOutput({ subChatId, commandId }: { subChatId: string; commandId: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  const { data } = trpc.socket.getCommandOutput.useQuery(
    { subChatId, commandId },
    {
      // Nothing is pulled while it is scrolled out of view, nor once it stops running (null).
      enabled: onScreen,
      refetchInterval: (query) => (query.state.data ? POLL_MS : false),
    },
  );
  const outputRef = useRef<HTMLPreElement>(null);
  // Follow the newest line, unless the user has scrolled up to read an earlier one.
  const followRef = useRef(true);
  const text = data?.text;
  useEffect(() => {
    const output = outputRef.current;
    if (output && followRef.current) output.scrollTop = output.scrollHeight;
  }, [text]);

  const runningFor = data?.runningForMs == null ? '' : formatElapsedTime(data.runningForMs);
  // One element throughout, so the visibility observer keeps watching what is on screen.
  return (
    <div
      ref={rootRef}
      className={data ? 'mt-1.5 mb-0.5 space-y-1 text-xs text-muted-foreground' : undefined}
    >
      {runningFor ? <div className="tabular-nums">Running for {runningFor}</div> : null}
      {!data ? null : text ? (
        <pre
          ref={outputRef}
          onScroll={(event) => {
            const output = event.currentTarget;
            followRef.current = output.scrollHeight - output.scrollTop - output.clientHeight < 4;
          }}
          className="max-h-40 overflow-auto rounded-md border border-border bg-background/40 px-2 py-1 font-mono leading-4 text-foreground/90"
        >
          {text}
        </pre>
      ) : (
        <div>{text === null ? 'Its output isn’t available.' : 'No output yet.'}</div>
      )}
    </div>
  );
}

/** Whether the element is in view, including inside a scrolled transcript; true where the browser
 * offers no IntersectionObserver, so output never silently stops. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(entry?.isIntersecting ?? false),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}
