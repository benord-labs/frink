/**
 * Builds the `systemPrompt.append` string for Claude Code SDK invocations.
 *
 * Claude SDK path only. The socket executor (executor.ts) is the sole caller, covering
 * both interactive chats and flow runs — they funnel through the same execute handler.
 * Codex never receives this content: it has no system-prompt channel, and its path prepends
 * only the multi-project prefix and flow briefing to the user message.
 *
 * Parts assembled (in order):
 *  1. FRINK_PLATFORM_BLOCK — always present; constant Frink identity + Flows primer
 *  2. AGENTS.md — appended when the file exists at cwd
 *  3. Multi-project block — appended when multiProjectPrefix is non-empty
 *  4. Plan lifecycle blocks — appended only for plan mode. Interactive task completion is
 *     enforced by the provider's native Stop hook, after any background work has settled.
 */

import { LAUNCH_FLAGS } from '../../shared/launch-flags';
import {
  CLAUDE_PLAN_MODE_LIFECYCLE_BLOCK,
  FLOW_PLAN_AUTO_APPROVE_BLOCK,
  FLOW_PLAN_MODE_QUESTION_BLOCK,
} from '../../shared/lib/task-agent-lifecycle-prompt';
import { readAgentsMd } from './claude/read-agents-md';

/**
 * Optional Flows primer + behavioral guidance — included only when
 * LAUNCH_FLAGS.flows is on. Detailed how-to lives in the `frink-flows`
 * Claude skill at `~/.frink/skills/frink-flows/` (auto-loaded on demand
 * via Skill discovery; not in this system prompt).
 */
const FLOWS_BLOCK = `## Flows

Frink includes a visual automation system called Flows — pipelines of triggers, agents, commands, and logic blocks that run automatically. Flows are the right tool when work needs to be repeated, parallelized, or run unattended.

Proactively suggest Flows when the user describes:
 - Batch work or bulk operations ("do this across all repos", "run this on every ticket")
 - Recurring or scheduled tasks ("every morning", "when a PR is merged")
 - Multi-step automations that should run without supervision
 - Consistency requirements across many similar runs ("make sure they all follow the same spec")

Do not suggest Flows for one-off tasks that are simpler to do directly in the conversation.

When building or editing Flows, always consult the \`frink-flows\` skill first (auto-loaded; lives at \`~/.frink/skills/frink-flows/\`, whose \`SKILL.md\` routes you to the reference file for your task) — do not guess at the schema. Validate template variables before saving. If the user wants many agent runs to share context (a spec, PRD, or checklist), use the Flow Briefing setting so every agent in the flow receives the same instructions without per-node duplication.`;

const FLOW_BULLET = LAUNCH_FLAGS.flows
  ? '\n - When the user asks about automation, triggers, scheduling, or batch work, think about whether a Flow would help before jumping to a one-off implementation.'
  : '';

const INTRO_LINE = LAUNCH_FLAGS.flows
  ? 'You are operating as Frink, an AI coding assistant that manages projects, tasks, and automation. Frink wraps your capabilities with multi-project context, task orchestration, and visual automation pipelines called Flows.'
  : 'You are operating as Frink, an AI coding assistant that manages projects and tasks. Frink wraps your capabilities with multi-project context and task orchestration.';

const ENVIRONMENT_LINE = LAUNCH_FLAGS.flows
  ? 'You are running in the Frink desktop app. The user may have multiple projects registered. You have access to MCP tools provided by Frink for managing flows, switching projects, and interacting with the platform. These tools are always available — you do not need to install or configure them.'
  : 'You are running in the Frink desktop app. The user may have multiple projects registered. You have access to MCP tools provided by Frink for switching projects and interacting with the platform. These tools are always available — you do not need to install or configure them.';

/**
 * Constant Frink platform block injected into every Claude Code session.
 * Behavioral guidance — identity, context, when to use capabilities.
 * Tool names are intentionally omitted; they're self-documenting via MCP tool descriptions.
 */
export const FRINK_PLATFORM_BLOCK = [
  '# Frink',
  '',
  INTRO_LINE,
  '',
  '## Your environment',
  '',
  ENVIRONMENT_LINE,
  '',
  "When the user works on a project, you operate in that project's directory with full access to its codebase. If the user has multiple projects, you may be given tools to search across them or switch context — use these when the current task requires information or actions from a different project.",
  ...(LAUNCH_FLAGS.flows ? ['', FLOWS_BLOCK] : []),
  '',
  '## Working in Frink',
  '',
  " - You are a collaborator. When you spot something adjacent to the user's request — a bug, a missed edge case, a better approach — say so. Users benefit from your judgment, not just compliance." +
    FLOW_BULLET,
  ' - Results and plan approvals go through the user. Never auto-push, auto-merge, or take irreversible actions without confirmation.',
  '',
  '## MCP servers',
  '',
  "MCP servers available in this session are managed through the Frink desktop app Settings (Agents & MCP tab). Configuration is stored in ~/.frink/mcp/config.json, NOT in ~/.claude/settings.json or ~/.claude.json. When the user asks about adding, removing, or troubleshooting MCP servers, direct them to the Frink Settings UI. Do not suggest editing Claude's own config files.",
]
  .join('\n')
  .trim();

/**
 * Assembles the `append` string for `systemPrompt: { type: 'preset', preset: 'claude_code', append }`.
 *
 * Returns an empty string if all parts are empty (caller should skip systemPrompt.append in that case,
 * though the Frink block is always non-empty so this will always return a non-empty string in practice).
 */
export async function buildFrinkSystemPromptAppend(opts: {
  cwd: string;
  multiProjectPrefix?: string;
  /**
   * Whether the caller registered task lifecycle support. Retained for plan-mode callers;
   * interactive agent mode relies on the provider's native Stop hook.
   */
  isTaskExecution?: boolean;
  /**
   * When true (plan-mode run), the Claude-native plan-mode lifecycle block is appended instead of
   * the signal-demanding one: it points at ExitPlanMode and forbids `frink_task_signal`.
   */
  isPlanMode?: boolean;
  /**
   * Plan mode inside a Flow: AskUserQuestion is denied there, so the agent is pointed at the one
   * signal state plan mode allows (`awaiting_input` parks, it does not terminalize). Flow-scoped —
   * an attended plan chat keeps AskUserQuestion and must not be steered into a park.
   */
  isFlowDriven?: boolean;
  /** Plan node with autoApprove/skipReview: warn that no human will review the plan. */
  planAutoApprove?: boolean;
}): Promise<string> {
  const parts: string[] = [FRINK_PLATFORM_BLOCK];

  const agentsMdContent = await readAgentsMd(opts.cwd);
  if (agentsMdContent) {
    parts.push(
      `# AGENTS.md\nThe following are the project's AGENTS.md instructions:\n\n${agentsMdContent}`,
    );
  }

  if (opts.multiProjectPrefix) {
    parts.push(opts.multiProjectPrefix);
  }

  if (opts.isPlanMode) {
    parts.push(CLAUDE_PLAN_MODE_LIFECYCLE_BLOCK);
    if (opts.isFlowDriven) {
      parts.push(FLOW_PLAN_MODE_QUESTION_BLOCK);
      if (opts.planAutoApprove) parts.push(FLOW_PLAN_AUTO_APPROVE_BLOCK);
    }
  }

  return parts.join('\n\n');
}
