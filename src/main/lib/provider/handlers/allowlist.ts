import log from 'electron-log';
import { REQUIRED_TOOLS } from '../../../../shared/types/permissions';
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
 *    like any other tool name, since agents may list them.
 *  - REQUIRED tools (ExitPlanMode/TodoWrite/Task/Agent) always pass the
 *    `tools`-membership check — the SDK grants sub-agents these infra tools whether
 *    or not an author lists them, and denying them bricks the agent (same reason
 *    the rule-validator refuses user `deny` rules on them). Not a security
 *    boundary; the tier-1c kill-switches remain canonical.
 *  - UNKNOWN agents fail OPEN (allowed): the threat model is over-grant of a
 *    RESTRICTED agent — spoofing INTO a restricted name only tightens, and an
 *    unknown name has no recorded restriction to enforce. Deny-unknown would brick
 *    renamed agents and any non-frink agent for zero security gain.
 *
 * Provider-agnostic: NO per-provider branch is needed. The `enforce` mode binds at the
 * provider's permission gate, not here — Claude via `canUseTool`, Codex via the
 * `codex app-server` ExecCommand/ApplyPatch approval callback the runner wires to Frink's
 * gate. This pure decision is the same for every enforce provider.
 */

export type AgentToolRestrictions = {
  tools?: string[];
  disallowedTools?: string[];
};

/** Pure allowlist decision for one attributed tool call. */
export function isToolAllowedForAgent(
  toolName: string,
  restrictions: AgentToolRestrictions,
): boolean {
  if (restrictions.disallowedTools?.includes(toolName) && !REQUIRED_TOOLS.has(toolName)) {
    return false;
  }
  if (restrictions.tools && !restrictions.tools.includes(toolName)) {
    return REQUIRED_TOOLS.has(toolName); // infra tools always pass the membership check
  }
  return true;
}

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
