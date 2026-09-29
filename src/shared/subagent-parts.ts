/**
 * The pseudo-tool a subagent's prose travels as.
 *
 * Subagent output is attributed to its card by a composite `"<parentToolCallId>:<childId>"`
 * toolCallId. Plain assistant text cannot carry one — the AI SDK's `TextUIPart` has no id field —
 * so a subagent's prose is emitted in the same tool shape the Thinking card already uses, which
 * does. Shared because the main process mints these parts and the renderer nests them.
 */
export const SUBAGENT_TEXT_TOOL_NAME = 'SubagentText';

export const SUBAGENT_TEXT_PART_TYPE = `tool-${SUBAGENT_TEXT_TOOL_NAME}` as const;

/** Tool-shaped parts that carry narration (subagent prose, reasoning), not work the agent did. */
export const NARRATION_PART_TYPES: ReadonlySet<string> = new Set([
  SUBAGENT_TEXT_PART_TYPE,
  'tool-Thinking',
]);

/**
 * The pseudo-tool a codex `collabAgentToolCall` travels as.
 *
 * Codex spawns and waits on subagents through its own protocol items rather than a `Task` tool, so
 * without a shared name those jobs would render as a generic card while the identical Claude flow
 * renders as a subagent card. Minting them under this name routes both providers through the same
 * `AgentTaskTool` (live elapsed timer, Running/Completed Subagent). Shared because the main process
 * mints these parts and the renderer classifies them.
 */
export const CODEX_SUBAGENT_TOOL_NAME = 'CodexSubagent';
