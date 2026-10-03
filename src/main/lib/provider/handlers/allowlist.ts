import log from 'electron-log';
import { KNOWN_TOOLS, REQUIRED_TOOLS } from '../../../../shared/types/permissions';
import type { CategoryHandler } from './types';

/**
 * PCH-5 — enforce a sub-agent's tool-allowlist at the provider gate.
 *
 * Defense-in-depth behind the SDK's own per-agent `tools`/`disallowedTools`
 * filtering: the session's PreToolUse allowlist hook (which carries `agent_id`/`agent_type`
 * attribution — `canUseTool` does not) routes attributed sub-agent tool calls here
 * and hard-denies an off-allowlist call on an `enforce` provider. On an `advisory`
 * provider (Cursor — no host veto) nothing is denied; the degrade is the coarse
 * `readonly:` frontmatter the agent-brain projection stamps.
 *
 * Honest limits, by design:
 *  - NAME-level matching only (no tool-argument inspection). `mcp__*` names match
 *    like any other tool name; `mcp__srv__*` or bare `mcp__srv` covers server `srv`.
 *  - REQUIRED tools (ExitPlanMode/TodoWrite/Task/Agent/SubagentHandback) always pass the
 *    `tools`-membership check — the SDK grants sub-agents these infra tools whether
 *    or not an author lists them, and denying them bricks the agent (same reason
 *    the rule-validator refuses user `deny` rules on them). Not a security
 *    boundary; the tier-1c kill-switches remain canonical.
 *  - UNKNOWN agents fail OPEN (allowed): the threat model is over-grant of a
 *    RESTRICTED agent — spoofing INTO a restricted name only tightens, and an
 *    unknown name has no recorded restriction to enforce. Deny-unknown would brick
 *    renamed agents and any non-frink agent for zero security gain.
 */

export type AgentToolRestrictions = {
  tools?: string[];
  disallowedTools?: string[];
};

/** Whether one `tools`/`disallowedTools` entry covers `toolName`. */
function entryCovers(entry: string, toolName: string): boolean {
  if (entry === toolName) return true;
  const server = entry.endsWith('__*') ? entry.slice(0, -3) : entry;
  // A server entry names exactly one server: `mcp__*` alone is not a grant of every MCP tool.
  const serverName = server.startsWith('mcp__') ? server.slice('mcp__'.length) : '';
  if (!serverName || serverName.includes('__')) return false;
  return toolName.startsWith(`${server}__`);
}

const isListed = (toolName: string, entries: string[] | undefined): boolean =>
  entries?.some((entry) => entryCovers(entry, toolName)) ?? false;

/** Pure allowlist decision for one attributed tool call. */
export function isToolAllowedForAgent(
  toolName: string,
  restrictions: AgentToolRestrictions,
): boolean {
  if (isListed(toolName, restrictions.disallowedTools) && !REQUIRED_TOOLS.has(toolName)) {
    return false;
  }
  if (restrictions.tools && !isListed(toolName, restrictions.tools)) {
    return REQUIRED_TOOLS.has(toolName); // infra tools always pass the membership check
  }
  return true;
}

/** A built-in Frink has no record of. On Claude it passes with a warning: the SDK filtered first,
 * so it is plumbing a newer CLI grants that KNOWN_TOOLS/REQUIRED_TOOLS have not caught up with. */
export function isUnknownBuiltinTool(toolName: string): boolean {
  return (
    !toolName.startsWith('mcp__') && !KNOWN_TOOLS.has(toolName) && !REQUIRED_TOOLS.has(toolName)
  );
}

const warnedUnknownBuiltins = new Set<string>();

type AllowlistRule = {
  toolName: string;
  agentType: string;
  restrictions: AgentToolRestrictions;
};

export const enforceAllowlist: CategoryHandler = async ({ mode, rule, ctx }) => {
  if (mode !== 'enforce') {
    // Advisory provider — never deny; the coarse readonly projection is the degrade.
    return { category: 'allowlist', mode, status: 'noop', detail: 'advisory — no host veto' };
  }
  if (!rule) {
    // The spine's rule param is optional; without a call to judge there is nothing to enforce.
    return { category: 'allowlist', mode, status: 'noop', detail: 'no rule provided' };
  }
  const { toolName, agentType, restrictions } = rule as AllowlistRule;
  if (isToolAllowedForAgent(toolName, restrictions)) {
    return { category: 'allowlist', mode, status: 'enforced', detail: toolName };
  }
  const explicitlyDisallowed = isListed(toolName, restrictions.disallowedTools);
  if (ctx.provider === 'claude-code' && !explicitlyDisallowed && isUnknownBuiltinTool(toolName)) {
    if (!warnedUnknownBuiltins.has(toolName)) {
      warnedUnknownBuiltins.add(toolName);
      log.warn(
        `[provider] enforce:allowlist passed unknown built-in ${toolName} for agent '${agentType}' — add it to KNOWN_TOOLS or REQUIRED_TOOLS`,
      );
    }
    return {
      category: 'allowlist',
      mode,
      status: 'enforced',
      detail: `${toolName} (unknown built-in)`,
    };
  }
  log.warn(
    `[provider] enforce:allowlist DENY ${toolName} for agent '${agentType}' @ ${ctx.projectId}`,
  );
  return {
    category: 'allowlist',
    mode,
    status: 'denied',
    detail: `Agent '${agentType}' is limited to [${restrictions.tools?.join(', ') ?? '…'}]; ${toolName} is not on its allowlist`,
  };
};
