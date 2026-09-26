import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { isDesktopApp } from '../lib/utils/platform';

/** Delay before prefetch fires so we don't compete with critical app boot work. */
const PREFETCH_DELAY_MS = 2000;

/**
 * Background-prefetch the MCP queries used by Settings → MCPs so the page
 * renders instantly on first open instead of waiting on stdio probes.
 *
 * Both queries spawn child processes (one per configured MCP) with a 10s
 * per-server timeout — paying that cost upfront after boot beats paying it
 * the moment a user opens the settings tab.
 */
export function useMcpBackgroundPrefetch(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!isDesktopApp()) return;

    const handle = setTimeout(() => {
      void utils.mcp.getAggregatedMcpInfo.prefetch();
      void utils.claude.getAllMcpConfig.prefetch();
    }, PREFETCH_DELAY_MS);

    return () => clearTimeout(handle);
  }, [utils]);
}
