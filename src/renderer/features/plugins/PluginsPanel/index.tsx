/**
 * The Plugins tab's two views: the directory, and one plugin's page.
 *
 * The page replaces the directory in place rather than opening over it, so this
 * owns which of the two is showing. It lives here rather than in `Integrations`
 * so the file that owns provider connect flows does not also carry a rendering
 * concern.
 */
import { cn } from '@benord-labs/frink-primitives';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PluginDetail } from '../PluginDetail';
import { PluginsDirectory } from '../PluginsDirectory';

type Props = {
  /** Told when a plugin page opens or closes, so the host can hide its own header and tabs. */
  onDetailChange?: (open: boolean) => void;
  connectingProvider: string | null;
  /** Provider whose account dialog is open, or null when none is. */
  accountDialogProvider: string | null;
  onConnect: (pluginId: string) => void;
  onSelectAccount: (connectionId: string) => void;
};

export function PluginsPanel({
  onDetailChange,
  connectingProvider,
  accountDialogProvider,
  onConnect,
  onSelectAccount,
}: Props) {
  // An id, never a resolved plugin. A snapshot object would freeze the account
  // list and status at open time, so disconnecting the last account would leave
  // the page still asserting Connected over an account that no longer exists.
  const [openPluginId, setOpenPluginId] = useState<string | null>(null);
  const lastOpenedRef = useRef<string | null>(null);

  const open = useCallback((pluginId: string) => {
    lastOpenedRef.current = pluginId;
    setOpenPluginId(pluginId);
  }, []);

  const back = useCallback(() => setOpenPluginId(null), []);

  // A connect settling for another provider opens its account dialog wherever
  // the user has since walked to. Leaving the page up under it would drop them
  // back onto an unrelated plugin with no account of the dialog they just used;
  // a dialog for the plugin already on screen is exactly where it belongs.
  useEffect(() => {
    if (!accountDialogProvider) return;
    setOpenPluginId((current) => (current && current !== accountDialogProvider ? null : current));
  }, [accountDialogProvider]);

  // Before paint, so the host's header never flashes above the plugin page's own h1.
  const isDetailOpen = openPluginId !== null;
  useLayoutEffect(() => {
    onDetailChange?.(isDetailOpen);
    return () => onDetailChange?.(false);
  }, [isDetailOpen, onDetailChange]);

  return (
    <>
      {openPluginId ? (
        <PluginDetail
          pluginId={openPluginId}
          // This plugin's own connect only. `Boolean(connectingProvider)` would
          // spin the page during an unrelated provider's OAuth popup.
          isConnecting={connectingProvider === openPluginId}
          onBack={back}
          onConnect={onConnect}
          onSelectAccount={onSelectAccount}
        />
      ) : null}

      {/* Hidden rather than unmounted, so the directory's search and filter
          survive a round trip with no state lifted anywhere.

          It must be `display:none`: that is what removes the subtree from the
          accessibility tree AND the tab order. `opacity-0`, `sr-only` and
          `aria-hidden` each leave every row and the search input reachable by
          Tab from behind the page.

          Both views subscribe to `plugins.list`, which is the argument for this
          rather than against it — same key and options, so React Query serves
          one request from one cache entry. */}
      <div className={cn(openPluginId && 'hidden')}>
        <PluginsDirectory
          restoreFocusTo={openPluginId ? null : lastOpenedRef.current}
          onOpen={open}
        />
      </div>
    </>
  );
}
