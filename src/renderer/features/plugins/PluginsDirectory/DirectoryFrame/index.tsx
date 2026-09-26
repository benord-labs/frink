import type { ReactNode, RefObject } from 'react';

/**
 * Two columns once the list itself is wide enough, one below — measured against
 * the grid, not the viewport, since the settings pane can be narrow inside a
 * wide window.
 */
export const DIRECTORY_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(24rem,1fr))] gap-x-7';

type Props = {
  children: ReactNode;
  rootRef: RefObject<HTMLDivElement | null>;
};

/**
 * The directory is a pure catalog — no hero band. Suggestion content lives on
 * each plugin's own detail band, scoped to a live connection.
 */
export function DirectoryFrame({ children, rootRef }: Props) {
  return (
    <div ref={rootRef} className="mx-auto w-full max-w-[68rem] pb-12">
      {children}
    </div>
  );
}
