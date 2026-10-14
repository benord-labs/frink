import type {
  PromptResponse,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { UIMessageChunk } from '../../claude/types';
import {
  type KnownToolCall,
  PATH_TOOL_BY_KIND,
  type ReportSource,
  rememberToolCall,
  toolCallCommand,
  toolCallPaths,
} from './acp-tool-calls';

/** Card for a tool call whose kind Frink has no dedicated card for. */
const GENERIC_TOOL_NAME = 'AgentTool';
const UNCHECKED_TEXT =
  'Frink could not check this action against your rules, so it was not allowed.';

/** Why a turn ended early, in the user's words; a normal or cancelled end needs no message. */
const STOP_PROBLEMS = new Map<StopReason, string>([
  ['max_tokens', 'The agent stopped because it reached its output limit.'],
  ['max_turn_requests', 'The agent stopped because it reached its step limit for one turn.'],
  ['refusal', 'The agent declined to continue.'],
]);

const UNREADABLE_ANSWER = 'The agent sent a reply Frink could not read.';
/** Another program sends the prompt's answer, and it may not be an object at all. */
const answerSchema = z.looseObject({});

/** What one turn has streamed so far. */
export type AcpTurnState = {
  toolCalls: Map<string, KnownToolCall>;
  /** Calls Frink refused without asking, which the agent reports back as a user rejection. */
  unchecked: Set<string>;
  /** Calls the agent asked permission for. */
  asked: Set<string>;
  /** Calls whose last answer was an allow, with the questions allowed for each. */
  allowed: Map<string, Set<string>>;
  /** How often each id was started as a new call, so an answer reaches only the call it was for. */
  starts: Map<string, number>;
  openTextId: string | null;
  textRuns: number;
};

export function createAcpTurnState(): AcpTurnState {
  return {
    toolCalls: new Map(),
    unchecked: new Set(),
    asked: new Set(),
    allowed: new Map(),
    starts: new Map(),
    openTextId: null,
    textRuns: 0,
  };
}

/**
 * The call a report shows acting without Frink's allow: it finished although no answer allowed it,
 * or failed although it never asked. Only a quiet tool, named by its first title, may do either.
 */
export function unaskedAction(
  update: SessionUpdate,
  state: AcpTurnState,
  quietTools: readonly string[],
): KnownToolCall | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return undefined;
  }
  const toolCall = state.toolCalls.get(update.toolCallId);
  if (!toolCall || (toolCall.tool !== undefined && quietTools.includes(toolCall.tool))) {
    return undefined;
  }
  const { status, toolCallId } = toolCall;
  if (status === 'completed' && !state.allowed.has(toolCallId)) return toolCall;
  if (status === 'failed' && !state.asked.has(toolCallId)) return toolCall;
  return undefined;
}

/** Ends the open text run, so text after a thought or a tool card starts a new block below it. */
function endTextRun(state: AcpTurnState): UIMessageChunk[] {
  if (state.openTextId === null) return [];
  const id = state.openTextId;
  state.openTextId = null;
  return [{ type: 'text-end', id }];
}

function contentText(toolCall: ToolCallUpdate): string {
  return (toolCall.content ?? [])
    .flatMap((entry) =>
      entry.type === 'content' && entry.content.type === 'text' ? [entry.content.text] : [],
    )
    .join('\n');
}

function editInput(toolCall: ToolCallUpdate, filePath: string | undefined) {
  const diff = (toolCall.content ?? []).find((entry) => entry.type === 'diff');
  if (!diff) return { file_path: filePath };
  return { file_path: diff.path, old_string: diff.oldText ?? '', new_string: diff.newText };
}

function toolCard(
  toolCall: ToolCallUpdate,
): Pick<Extract<UIMessageChunk, { type: 'tool-input-available' }>, 'toolName' | 'input'> {
  const [filePath] = toolCallPaths(toolCall);
  if (toolCall.kind === 'execute') {
    return { toolName: 'Bash', input: { command: toolCallCommand(toolCall) ?? toolCall.title } };
  }
  if (toolCall.kind === 'edit') return { toolName: 'Edit', input: editInput(toolCall, filePath) };
  const pathTool = toolCall.kind ? PATH_TOOL_BY_KIND.get(toolCall.kind) : undefined;
  if (pathTool) return { toolName: pathTool, input: { file_path: filePath } };
  return { toolName: GENERIC_TOOL_NAME, input: { description: toolCall.title } };
}

/** Folds one report about a tool call into its card, ending any text that came before it. */
export function mapToolCall(
  update: ToolCallUpdate,
  state: AcpTurnState,
  source: ReportSource = 'tool_call_update',
): UIMessageChunk[] {
  const chunks = endTextRun(state);
  const isFirstReport = !state.toolCalls.has(update.toolCallId);
  // A new call on a known id inherits no answer given to the call before it.
  if (source === 'tool_call') {
    for (const calls of [state.asked, state.allowed, state.unchecked]) {
      calls.delete(update.toolCallId);
    }
    state.starts.set(update.toolCallId, (state.starts.get(update.toolCallId) ?? 0) + 1);
  }
  const toolCall = rememberToolCall(state.toolCalls, update, source);
  const { toolCallId } = toolCall;
  const card = toolCard(toolCall);
  if (isFirstReport) chunks.push({ type: 'tool-input-start', toolCallId, toolName: card.toolName });
  chunks.push({ type: 'tool-input-available', toolCallId, ...card });
  if (toolCall.status === 'completed') {
    chunks.push({
      type: 'tool-output-available',
      toolCallId,
      output: { output: contentText(toolCall) },
    });
  }
  if (toolCall.status === 'failed') {
    const reported = contentText(toolCall) || 'The tool call failed.';
    const errorText = state.unchecked.has(toolCallId) ? UNCHECKED_TEXT : reported;
    chunks.push({ type: 'tool-output-error', toolCallId, errorText });
  }
  return chunks;
}

/** Maps one ACP session update onto Frink's chat chunks. Updates Frink does not show map to none. */
export function mapSessionUpdate(update: SessionUpdate, state: AcpTurnState): UIMessageChunk[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text') return [];
      state.openTextId ??= `text-${++state.textRuns}`;
      return [{ type: 'text-delta', id: state.openTextId, delta: update.content.text }];
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return [];
      return [
        ...endTextRun(state),
        { type: 'reasoning-delta', id: 'thought', delta: update.content.text },
      ];
    }
    case 'tool_call':
    case 'tool_call_update':
      return mapToolCall(update, state, update.sessionUpdate);
    case 'usage_update':
      return [
        {
          type: 'message-metadata',
          messageMetadata: { contextTokens: update.used, contextWindow: update.size },
        },
      ];
    default:
      return [];
  }
}

/** The chunks a finished prompt adds: its token usage, and an error when the turn ended early. */
export function mapPromptResponse(response: PromptResponse): UIMessageChunk[] {
  if (!answerSchema.safeParse(response).success) {
    return [{ type: 'error', errorText: UNREADABLE_ANSWER }];
  }
  const chunks: UIMessageChunk[] = [];
  if (response.usage) {
    const { inputTokens, outputTokens, totalTokens } = response.usage;
    chunks.push({
      type: 'message-metadata',
      messageMetadata: { inputTokens, outputTokens, totalTokens },
    });
  }
  const problem = STOP_PROBLEMS.get(response.stopReason);
  if (problem) chunks.push({ type: 'error', errorText: problem });
  return chunks;
}
