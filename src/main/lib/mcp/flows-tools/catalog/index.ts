/**
 * Leaf handlers for `frink_flows_list_catalog` kinds that read a store directly.
 * `commands` and `templates` stay in the tool module: they resolve a flow first.
 */

import { listPluginToolsLimiter } from '../gating/session-call-limiters';
import { type McpToolResult, toolResult } from '../../tool-result';
import { listInstalledNodes, listPluginTools } from './nodes';

export { handleIntegrationsList } from './integrations';
export { handleProjectsList } from './projects';

/**
 * kind:'nodes'. Without `pluginId` this is a local manifest read; a slot is spent only
 * once the local preconditions pass and the call will reach the vendor.
 */
export async function handleNodesList(
  pluginId: string | undefined,
  search: string | undefined,
  executionId?: string,
): Promise<McpToolResult> {
  if (pluginId === undefined) return listInstalledNodes();
  return listPluginTools(pluginId, search, () =>
    listPluginToolsLimiter.tryAcquire(executionId ?? listPluginToolsLimiter.globalKey)
      ? null
      : toolResult(
          `Rate limit reached: listing a plugin's tools allows ${listPluginToolsLimiter.max} calls per chat session.`,
          true,
        ),
  );
}
