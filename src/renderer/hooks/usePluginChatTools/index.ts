import { useEffect, useReducer, useRef } from 'react';
import { toast } from 'sonner';
import {
  activeConsentUrl,
  CONSENT_IDLE,
  consentDialogOpen,
  consentViewReducer,
} from '../../lib/plugins/consent-view';
import { trpc } from '../../lib/trpc';
import { usePluginRefresh } from '../../lib/plugins/use-plugin-refresh';

type ChatToolsState = 'connected' | 'awaiting' | 'none' | 'unknown';

/** A plugin's MCP state from the store delivery reads; 'unknown' until the query settles so callers don't misread a load/error as 'no server'. `enable` runs the consent. */
export function usePluginChatTools(pluginName: string, options: { live?: boolean } = {}) {
  const utils = trpc.useUtils();
  const refresh = usePluginRefresh();
  const [consent, dispatch] = useReducer(consentViewReducer, CONSENT_IDLE);
  const cancelled = useRef(false);
  // Only status fetched after this attempt began may name its page: a poll still in flight is
  // cancelled, and the cached row from the previous attempt is older than `startedAt`.
  const startedAt = useRef(0);
  // Both channels: the dialog is only rendered where the page still shows it, the toast reaches everywhere.
  const report = (error: string, force = false) => {
    if (cancelled.current && !force) return;
    dispatch({ type: 'failed', error });
    toast.error('MCP was not enabled', { description: error });
  };
  const cancel = trpc.plugins.connectAttemptEnded.useMutation({
    // Reports the cancel's own failure without lifting the latch, which would let the
    // attempt still in flight re-open the dialog the user just dismissed.
    onError: (error) => report(error.message, true),
    onSettled: refresh,
  });
  const enable = trpc.plugins.connectVendorMcp.useMutation({
    onMutate: () => {
      cancelled.current = false;
      startedAt.current = Date.now();
      void utils.plugins.vendorMcpStatus.cancel();
      dispatch({ type: 'started' });
    },
    onSuccess: (outcomes) => {
      const failed = Object.values(outcomes).find((outcome) => !outcome.ok);
      if (failed) report(failed.error ?? '');
    },
    onError: (error) => report(error.message),
    onSettled: refresh,
  });
  // The consent finishes in a browser tab the QueryClient defaults would miss, so a `live`
  // page re-reads on mount/focus and every 3s — every second while a consent runs (its sign-in page).
  const status = trpc.plugins.vendorMcpStatus.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: enable.isPending ? 1000 : options.live ? 3000 : false,
  });
  // Ownership by the server's own `pluginName`: `plugin_foo_bar_baz` cannot be split by string rules.
  const owns = (entry: { pluginName: string }) => entry.pluginName === pluginName;
  const running = enable.isPending;
  const fresh = status.dataUpdatedAt > startedAt.current;
  const liveUrl =
    running && fresh && status.data ? activeConsentUrl(status.data.awaitingAuth, pluginName) : null;
  useEffect(() => {
    if (liveUrl) dispatch({ type: 'page', url: liveUrl });
  }, [liveUrl]);
  // A loading or errored query is 'unknown', never 'none' — and an errored refetch
  // must not reread its stale cached data as settled truth.
  // Connected outranks awaiting in a mixed multi-server payload: live tools never read as a missing grant.
  const state: ChatToolsState =
    status.isError || !status.data
      ? 'unknown'
      : status.data.connected.some(owns)
        ? 'connected'
        : status.data.awaitingAuth.some(owns)
          ? 'awaiting'
          : 'none';
  return {
    state,
    enable: (options?: { reconnect?: boolean }) => {
      if (!enable.isPending && !cancel.isPending) enable.mutate({ pluginName, ...options });
    },
    isEnabling: enable.isPending || cancel.isPending,
    consent: { url: consent.url, error: consent.error, open: consentDialogOpen(consent, running) },
    dismiss: () => {
      dispatch({ type: 'dismissed' });
      if (!enable.isPending || cancel.isPending) return;
      cancelled.current = true;
      cancel.mutate({ pluginId: pluginName });
    },
  };
}
