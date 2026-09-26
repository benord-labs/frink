import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

type Props = {
  children: ReactNode;
  isLastGroup?: boolean;
};

export const MessageGroup = ({ children, isLastGroup }: Props): ReactElement => {
  const groupRef = useRef<HTMLDivElement>(null);
  const userMessageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const groupEl = groupRef.current;
    if (!groupEl) return;

    // Find the actual bubble element (not the wrapper which includes gradient)
    const bubbleEl = groupEl.querySelector('[data-user-bubble]') as HTMLDivElement | null;
    if (!bubbleEl) return;

    userMessageRef.current = bubbleEl;

    // Set CSS variable directly on DOM - no React state, no re-renders
    const updateHeight = (height: number) => {
      groupEl.style.setProperty('--user-message-height', `${height}px`);
    };

    updateHeight(bubbleEl.offsetHeight);

    // Read the size from the entry: reading offsetHeight here forces a layout per group after the
    // previous group's write, which is a layout thrash across every group when panes resize.
    const observer = new ResizeObserver(([entry]) => {
      updateHeight(entry.borderBoxSize[0]?.blockSize ?? bubbleEl.offsetHeight);
    });
    observer.observe(bubbleEl);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={groupRef}
      // A skipped group renders at its last-remembered height, so skipping one that is still
      // settling snaps it and clamps scrollTop, which the scroll owner reads as a scroll-up. The
      // newest two groups are therefore never skipped. Positional on purpose: groups are the
      // trailing children of the scroll column — never render a sibling after them.
      className="relative [content-visibility:auto] [contain-intrinsic-size:auto_200px] [&:nth-last-child(-n+2)]:[content-visibility:visible]"
      // The viewport less the transcript's bottom reserve (MessagesScrollContainer), so a new turn
      // starts at the top of the viewport.
      style={
        isLastGroup
          ? { minHeight: 'calc(var(--chat-container-height) - var(--chat-dock-height) - 1.5rem)' }
          : undefined
      }
      data-last-group={isLastGroup || undefined}
    >
      {children}
    </div>
  );
};
