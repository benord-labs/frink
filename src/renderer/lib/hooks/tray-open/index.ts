import { useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import type { TrayTarget } from '../../../../shared/types/tray';
import { getUrlParam } from '../../utils/url-params';
import {
  leaveOverlayStackForChatSurfaceAtom,
  openDestinationAtom,
} from '../../atoms/agent-navigation-atoms';

type Route = {
  isMobile: boolean;
  isSplitActive: boolean;
  fillActivePane: (chatId: string) => void;
  selectChat: (chatId: string) => void;
};

type Destinations = {
  leaveOverlays: () => void;
  openWorkQueue: () => void;
};

/** Shows a menu bar row's target: its chat (in the active pane when split) or the Work Queue. */
export function routeTrayTarget(target: TrayTarget, route: Route, destinations: Destinations) {
  if ('view' in target) return destinations.openWorkQueue();
  // An open Flow editor is never dismissed for this: the chat waits behind it, selected.
  destinations.leaveOverlays();
  if (!route.isMobile && route.isSplitActive) route.fillActivePane(target.chatId);
  else route.selectChat(target.chatId);
}

/** Follows clicks on the menu bar (system tray) rows sent from the main process. */
export function useTrayOpen(route: Route) {
  const leaveOverlays = useSetAtom(leaveOverlayStackForChatSurfaceAtom);
  const openDestination = useSetAtom(openDestinationAtom);
  const routeRef = useRef(route);
  routeRef.current = route;
  // A window the menu bar reopened on macOS carries a Work Queue row's target in its URL.
  useEffect(() => {
    if (getUrlParam('view') !== 'workqueue') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', url);
    openDestination('workqueue');
  }, [openDestination]);
  useEffect(
    () =>
      window.desktopApi?.onTrayOpen?.((target) =>
        routeTrayTarget(target, routeRef.current, {
          leaveOverlays,
          openWorkQueue: () => openDestination('workqueue'),
        }),
      ),
    [leaveOverlays, openDestination],
  );
}
