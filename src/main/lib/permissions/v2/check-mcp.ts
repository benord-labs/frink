/**
 * MCP tool checker. Pure function — rules-only (no tier-1c).
 *
 * Ticket 05 of the permissions overhaul.
 */

import { parseMcpToolFullName } from '../../../../shared/lib/mcp-tool-name';
import { isVendorPluginMcpServer } from '../../../../shared/lib/mcp-tool-name';
import { parseRule } from '../../../../shared/lib/rule-parser';
import { combineScopes, evalScope, resultFromCombined, type ScopedDocs } from './eval-rules';
import type { PermissionResult } from './types';

/**
 * A vendor-plugin server (claude-code namespaces them plugin_<name>_<server>)
 * never gets the server-wildcard suggestion — one approved Slack tool must not
 * grant every tool the vendor ships (sc-1831; sc-1843 item 4).
 */
function suggestedMcpRules(
  server: string,
  exact: string,
  wildcard: string,
  canPersistExact: boolean,
): string[] {
  if (isVendorPluginMcpServer(server)) return canPersistExact ? [exact] : [];
  return canPersistExact ? [exact, wildcard] : [wildcard];
}

export function checkMcp(
  input: {
    toolName: string;
    toolInput: unknown;
    mcpIdentity?: { server: string; tool: string };
  },
  docs: ScopedDocs,
): PermissionResult {
  const context = input.mcpIdentity ? { mcpIdentity: input.mcpIdentity } : undefined;
  const policy = evalScope(docs.policy, input.toolName, input.toolInput, context);
  const project = evalScope(docs.project, input.toolName, input.toolInput, context);
  const user = evalScope(docs.user, input.toolName, input.toolInput, context);
  const result = resultFromCombined(
    combineScopes(policy, project, user),
    input.toolName,
    input.toolInput,
  );
  // On `ask`, attach `suggestedRules` so FourButtonView's dropdown offers both
  // narrow (exact tool) and wide (server-wildcard) options. Mirrors check-edit
  // post-resultFromCombined mutation — Bash builds suggestions inline because
  // they depend on command tokenization; MCP only needs the parsed fullname.
  if (result.decision === 'ask') {
    const identity = input.mcpIdentity;
    const parsed = identity ? null : parseMcpToolFullName(input.toolName);
    const server = identity?.server ?? parsed?.serverName;
    const tool = identity?.tool ?? parsed?.toolName;
    if (server && tool) {
      const wildcard = `mcp__${server}__*`;
      const exact = `mcp__${server}__${tool}`;
      const parsedExact = parseRule(exact);
      const canPersistExact =
        !server.includes('__') &&
        !tool.includes('__') &&
        tool !== '*' &&
        !('error' in parsedExact) &&
        parsedExact.tool === exact &&
        parsedExact.content === undefined;
      result.prompt.suggestedRules = suggestedMcpRules(server, exact, wildcard, canPersistExact);
    }
  }
  return result;
}
