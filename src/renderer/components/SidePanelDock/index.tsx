import { useAtomValue, useSetAtom } from 'jotai';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sidePanelDockAtom } from '@/lib/atoms/side-panel-dock';

/** Right of the main pane, mirroring the left sidebar. `hidden` follows the chat while Work Queue
 * or Settings covers it, since portalled panels leave the chat's hidden section. */
export function SidePanelDockHost({ hidden }: { hidden: boolean }): ReactElement {
  const setDock = useSetAtom(sidePanelDockAtom);
  // pl-1 matches the left sidebar's gap to the pane; hidden while empty so it adds no layout gap
  return (
    <div
      ref={setDock}
      hidden={hidden}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className="flex shrink-0 pl-1 empty:hidden"
    />
  );
}

/** Renders a chat's side panels in the dock when `docked`; split panes keep theirs in the pane. */
export function SidePanelDockPortal({
  docked,
  children,
}: {
  docked: boolean;
  children: ReactNode;
}): ReactNode {
  const dock = useAtomValue(sidePanelDockAtom);
  return docked && dock ? createPortal(children, dock) : children;
}
