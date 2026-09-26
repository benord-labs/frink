import { project as createProjectProvider } from '../provider';

/**
 * Sub-agents cannot park a run; only the agent that owns the turn can reach the user.
 *
 * Refused here rather than in `canUseTool` because only PreToolUse carries agent attribution: in
 * `canUseTool` a sub-agent's AskUserQuestion is indistinguishable from the main agent's (which is
 * HELD, and on expiry parks the run and ends the turn) — so a sub-agent's question would hold the
 * PARENT's turn open, and expire it on a question the parent has already moved past.
 *
 * PreToolUse is also the only seam whose reason survives: the CLI discards a `canUseTool` deny
 * message and substitutes its own canned refusal, while a hook's `permissionDecisionReason` is
 * delivered verbatim. A deny that must be understood therefore belongs here by construction.
 */
const SUBAGENT_ASK_DENIED_MESSAGE =
  'AskUserQuestion is unavailable to sub-agents — only the agent that owns the turn can reach the user. Decide, and report the choice and your reasoning back to the main agent as an explicit assumption.';

export type SubagentHookInput = {
  hook_event_name: string;
  tool_name: string;
  tool_input: unknown;
  agent_id?: string;
  agent_type?: string;
};

type AgentDef = { tools?: string[]; disallowedTools?: string[] };

/**
 * PCH-5: sub-agent allowlist backstop — defense-in-depth behind the SDK's own per-agent
 * tools/disallowedTools filtering. Registered with NO matcher (covers every tool, incl. `mcp__*`
 * which the 9-tool matcher entry does not) but acts ONLY on attributed sub-agent calls: `agent_id`
 * is present in hook input solely when a native subagent fires the tool, so the main thread
 * short-circuits on the first check with zero allocations. Unknown agent names fail OPEN — the
 * threat is over-grant of a RESTRICTED agent, and spoofing INTO a restricted name only tightens
 * (reasoning + the pure matcher live in provider/handlers/allowlist.ts).
 *
 * A SEPARATE callback from the PreToolUse permission hook (session-callbacks.ts) so the permission
 * flow (validateToolPermission, prompts) never runs twice for matched tools. `markDenied` is
 * injected, not imported: the denial lands on the LIVE turn, which only session callbacks resolve.
 */
/** The agent's own allowlist verdict for this call: a denial reason, or null to let it through. */
async function resolveAllowlistDenial(
  hookInput: SubagentHookInput,
  agentType: string,
  agents: Record<string, AgentDef>,
  project: { id: string },
  projectPath: string,
): Promise<string | null> {
  const def = agents[agentType];
  if (!def || (!def.tools && !def.disallowedTools)) return null;
  const result = await createProjectProvider(project.id, projectPath, 'claude-code').enforce(
    'allowlist',
    {
      toolName: hookInput.tool_name,
      agentType,
      restrictions: { tools: def.tools, disallowedTools: def.disallowedTools },
    },
  );
  if (result.status !== 'denied') return null;
  return result.detail ?? `${hookInput.tool_name} is not on agent '${agentType}' allowlist`;
}

function denyHookResult(hookInput: SubagentHookInput, reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: hookInput.hook_event_name,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

export function createSubagentAllowlistHook(deps: {
  agents: Record<string, AgentDef>;
  project: { id: string } | null | undefined;
  projectPath: string;
  markDenied: (toolUseId: string, reason: string) => void;
}) {
  const { agents, project, projectPath, markDenied } = deps;
  return async (hookInput: SubagentHookInput, toolUseId: string) => {
    const agentType = hookInput.agent_type;
    if (!hookInput.agent_id || !agentType) return {};
    // Asking the user is refused ahead of the `project` guard — that one gates allowlist lookup, and
    // who may reach the user does not depend on it. Refused on EVERY turn, not just flow-driven
    // ones: the hold applies to every turn now, so a sub-agent ask would hold its parent's anywhere.
    if (hookInput.tool_name === 'AskUserQuestion') {
      markDenied(toolUseId, SUBAGENT_ASK_DENIED_MESSAGE);
      return denyHookResult(hookInput, SUBAGENT_ASK_DENIED_MESSAGE);
    }
    if (!project) return {};
    const reason = await resolveAllowlistDenial(hookInput, agentType, agents, project, projectPath);
    if (!reason) return {};
    markDenied(toolUseId, reason);
    return denyHookResult(hookInput, reason);
  };
}
