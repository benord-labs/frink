import { trpc } from '../trpc';

/** Invalidates every query a plugin lifecycle action can change, the Flow node palette included.
 * Callers use it on `onSettled`: even a failure may have disconnected accounts already. */
export function usePluginRefresh(): () => void {
  const utils = trpc.useUtils();
  return () => {
    void utils.plugins.list.invalidate();
    void utils.plugins.vendorMcpStatus.invalidate();
    void utils.integrations.invalidate();
    void utils.triggerSetup.options.invalidate();
    void utils.customNodes.list.invalidate();
  };
}
