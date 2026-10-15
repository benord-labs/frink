import { z } from 'zod';
import type { UIMessageChunk } from '../../claude/types';
import { endTextRun } from '../codex/codex-stream-chunks';

type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type Ids = { agent_id: string; run_id: string };

/** Cursor's SDK run messages, named and shaped as the SDK names them. */
export type CursorSdkMessage = Ids &
  (
    | { type: 'system'; subtype?: 'init'; model?: CursorModel; tools?: string[] }
    | { type: 'user'; message: { role: 'user'; content: TextBlock[] } }
    | {
        type: 'assistant';
        message: { role: 'assistant'; content: Array<TextBlock | ToolUseBlock> };
      }
    | {
        type: 'tool_call';
        call_id: string;
        name: string;
        status: 'running' | 'completed' | 'error';
        args?: unknown;
        result?: unknown;
        truncated?: { args?: boolean; result?: boolean };
      }
    | { type: 'thinking'; text: string; thinking_duration_ms?: number }
    | {
        type: 'status';
        status: 'CREATING' | 'RUNNING' | 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED';
        message?: string;
      }
    | { type: 'request'; request_id: string }
    | { type: 'task'; status?: string; text?: string }
    | { type: 'usage'; usage: CursorTokenUsage }
  );

/** A model and the parameter values chosen for it, as the SDK takes them. */
export type CursorModel = { id: string; params?: { id: string; value: string }[] };
type CursorTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

/** Card for a tool Frink has no dedicated card for. */
const GENERIC_TOOL_NAME = 'AgentTool';
const TOOL_FAILED = 'The tool call failed.';
const CARDS = new Map([
  ['shell', 'Bash'],
  ['edit', 'Edit'],
  ['read', 'Read'],
  ['delete', 'Delete'],
]);

const argsSchema = z.object({ command: z.string(), path: z.string() }).partial();
const resultSchema = z.union([
  z.object({
    status: z.literal('success'),
    value: z
      .object({
        diffString: z.string(),
        content: z.string(),
        stdout: z.string(),
        stderr: z.string(),
      })
      .partial(),
  }),
  z.object({ error: z.object({ message: z.string() }) }),
]);

/** What one turn has streamed so far. */
export type CursorEventState = { openTextId: string | null; textRuns: number };

export function createCursorEventState(): CursorEventState {
  return { openTextId: null, textRuns: 0 };
}

function toolCard(name: string, { command, path }: z.infer<typeof argsSchema>) {
  if (name === 'shell') return { command };
  return CARDS.has(name) ? { file_path: path } : { description: name };
}

function toolOutput(callId: string, parsed?: z.infer<typeof resultSchema>): UIMessageChunk {
  if (parsed && 'value' in parsed) {
    const { diffString, content, stdout, stderr } = parsed.value;
    // A command that exits non-zero still succeeds, so its stderr is shown after its stdout.
    const output = diffString ?? content ?? [stdout, stderr].filter(Boolean).join('\n');
    return { type: 'tool-output-available', toolCallId: callId, output: { output } };
  }
  const errorText = parsed?.error.message ?? TOOL_FAILED;
  return { type: 'tool-output-error', toolCallId: callId, errorText };
}

/** Maps one Cursor SDK message onto Frink's chat chunks. Messages Frink does not show map to none. */
export function mapCursorMessage(
  message: CursorSdkMessage,
  state: CursorEventState,
): UIMessageChunk[] {
  switch (message.type) {
    case 'assistant': {
      const delta = message.message.content.flatMap((block) =>
        block.type === 'text' ? [block.text] : [],
      );
      if (delta.length === 0) return [];
      if (state.openTextId === null) state.textRuns += 1;
      state.openTextId = `cursor-text-${state.textRuns}`;
      return [{ type: 'text-delta', id: state.openTextId, delta: delta.join('') }];
    }
    case 'thinking':
      return [
        ...endTextRun(state),
        { type: 'reasoning-delta', id: 'cursor-thinking', delta: message.text },
      ];
    case 'tool_call': {
      const { call_id: toolCallId, name } = message;
      if (message.status !== 'running') {
        return [toolOutput(toolCallId, resultSchema.safeParse(message.result).data)];
      }
      const toolName = CARDS.get(name) ?? GENERIC_TOOL_NAME;
      const input = toolCard(name, argsSchema.safeParse(message.args).data ?? {});
      return [
        ...endTextRun(state),
        { type: 'tool-input-start', toolCallId, toolName },
        { type: 'tool-input-available', toolCallId, toolName, input },
      ];
    }
    case 'usage': {
      const { inputTokens, outputTokens } = message.usage;
      const totalTokens = inputTokens + outputTokens;
      return [
        { type: 'message-metadata', messageMetadata: { inputTokens, outputTokens, totalTokens } },
      ];
    }
    default:
      return [];
  }
}
