import log from 'electron-log';
import type { CategoryHandler } from './types';

/**
 * Intentional noop — each runner injects MCP servers itself at spawn (it holds the config), which
 * satisfies `mcp=inject`. Spine routing is deferred: see `provider-config-canonical-home`.
 */
export const deliverMcp: CategoryHandler = async ({ mode, ctx }) => {
  log.info(
    `[provider] deliver:mcp ${mode} (noop — direct path) → ${ctx.provider} @ ${ctx.projectId}`,
  );
  return {
    category: 'mcp',
    mode,
    status: 'noop',
    detail: 'delivered via direct path (deferred from spine)',
  };
};
