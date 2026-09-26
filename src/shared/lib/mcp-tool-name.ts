import { vendorPluginPin } from '../integrations/vendor-plugin-pins';
/**
 * Shared MCP tool-name parsing + formatting. MCP tool calls flow through
 * frink via two distinct prefixes:
 *  - Mention provider serializes `mcp__<server>__<tool>` (no `tool-` prefix).
 *  - AI SDK message parts use `tool-mcp__<server>__<tool>`.
 *
 * Helpers below operate on the bare `mcp__<server>__<tool>` form. Callers
 * strip any `tool-` prefix before invoking.
 */

export type ParsedMcpToolFullName = {
  serverName: string;
  toolName: string;
};

/**
 * Parse a bare MCP tool fullname into its server + tool components.
 * Returns null for any input that does not match `mcp__<server>__<tool>`.
 */
export function parseMcpToolFullName(fullName: string): ParsedMcpToolFullName | null {
  if (!fullName.startsWith('mcp__')) return null;
  const withoutPrefix = fullName.slice('mcp__'.length);
  const separatorIndex = withoutPrefix.indexOf('__');
  if (separatorIndex === -1) return null;
  const serverName = withoutPrefix.slice(0, separatorIndex);
  const toolName = withoutPrefix.slice(separatorIndex + 2);
  if (!serverName || !toolName) return null;
  return { serverName, toolName };
}

/** claude-code's `plugin_<plugin>_<server>` namespacing — a name-space, not a trust signal. */
export function isVendorPluginMcpServer(serverName: string): boolean {
  return serverName.startsWith('plugin_');
}

/**
 * Compose the namespaced server key frink uses when IT delivers a
 * plugin-shipped MCP server (codex panes) — byte-identical to the
 * `plugin_<plugin>_<server>` convention claude-code's own plugin loader uses,
 * so permission rules match across providers. Returns null when the parts
 * would corrupt the `mcp__<server>__<tool>` parse (an embedded/trailing `_`
 * producing `__`) or a codex TOML table key (non-word characters like the
 * `@` in a marketplace-qualified id — callers must pass the pin NAME).
 */
export function vendorPluginMcpServerName(pluginName: string, serverKey: string): string | null {
  const name = `plugin_${vendorPluginPin(pluginName)?.name ?? pluginName}_${serverKey}`;
  // A trailing `_` would fuse with the tool separator (`<name>__tool` → `___`),
  // shifting where parseMcpToolFullName splits — reject it like an embedded `__`.
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.includes('__') || name.endsWith('_')) return null;
  return name;
}

/** Server key for frink's in-app dynamic-chat MCP. */
export const FRINK_DYNAMIC_CHAT_MCP_KEY = 'frink_dynamic_chat';
/** Server key frink injects into `~/.claude.json` (Claude Code CLI). */
const FRINK_CLAUDE_MCP_KEY = 'frink';

/**
 * MCP server names frink injects into agent configs that point back at frink's own
 * MCP proxy. These tools are trusted — auto-approved at the permission gate, never prompted.
 * Single source of truth for the two keys above (also aliased as `FRINK_LOOPBACK_KEYS`
 * in import-scanner.ts).
 */
export const FRINK_OWNED_MCP_SERVERS = new Set([FRINK_DYNAMIC_CHAT_MCP_KEY, FRINK_CLAUDE_MCP_KEY]);

/** True for a bare `mcp__<frink-server>__<tool>` fullname. */
export function isFrinkOwnedMcpTool(fullName: string): boolean {
  const parsed = parseMcpToolFullName(fullName);
  return parsed !== null && FRINK_OWNED_MCP_SERVERS.has(parsed.serverName);
}

/**
 * The frink flow tools that MUTATE state (no `readOnlyHint` annotation).
 * These consult the normal v2 permission rule scopes instead of the
 * frink-owned trust auto-allow. Kept in sync with `FLOWS_TOOLS` annotations
 * by a set-equality test in `src/main/lib/mcp/flows-tools/index.test.ts`.
 */
export const FRINK_MUTATING_FLOW_TOOLS: ReadonlySet<string> = new Set([
  'frink_flows_patch',
  'frink_flows_run',
  'frink_register_node',
  'frink_batch_message',
  'frink_flows_define_stages',
  'frink_flows_add_stage_runs',
  'frink_flows_start_batch',
]);

/** True for a bare `mcp__<frink-server>__<mutating-flow-tool>` fullname. */
export function isFrinkMutatingFlowTool(fullName: string): boolean {
  const parsed = parseMcpToolFullName(fullName);
  return (
    parsed !== null &&
    FRINK_OWNED_MCP_SERVERS.has(parsed.serverName) &&
    FRINK_MUTATING_FLOW_TOOLS.has(parsed.toolName)
  );
}

/**
 * Format an MCP tool name for display. Converts snake_case AND kebab-case to
 * Title Case (real MCP tool names mix both: `search_items`, `stories-list`),
 * collapses repeated whitespace, and trims.
 */
export function formatMcpToolName(toolName: string): string {
  return toolName
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose `parseMcpToolFullName` + `formatMcpToolName` to produce a
 * display-ready `{ tool, server }` pair. Falls back to the raw string +
 * `server: null` when the input isn't a parseable `mcp__server__tool` shape
 * (frink-internal MCP, malformed names). Single source of truth for the
 * friendly-name shape used in PromptBody, SimpleApprovalView, mention
 * provider, and tool-registry rendering.
 */
export function friendlyMcpName(fullName: string): { tool: string; server: string | null } {
  const parsed = parseMcpToolFullName(fullName);
  if (!parsed) return { tool: fullName || 'MCP tool', server: null };
  return { tool: formatMcpToolName(parsed.toolName), server: parsed.serverName };
}
