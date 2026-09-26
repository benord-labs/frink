import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { isDesktopApp } from '../lib/utils/platform';

/** On `mcp:imported` (boot importer added entries), invalidates the pre-fetched MCP queries so the
 * new entries appear in Settings → MCPs without a manual refresh. */
export function useMcpImportInvalidation(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!isDesktopApp()) return;

    const unsub = window.desktopApi?.onMcpImported(() => {
      void utils.mcp.getAggregatedMcpInfo.invalidate();
      void utils.mcp.listGlobalServers.invalidate();
      void utils.claude.getAllMcpConfig.invalidate();
    });

    return () => {
      unsub?.();
    };
  }, [utils]);
}
