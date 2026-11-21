import { z } from 'zod';
import { FRINK_MCP_KEY, frinkToolPartName } from '../../../../shared/lib/mcp-tool-name';
import type { UIMessageChunk } from '../../claude/types';
import { frinkToolOutput } from '../../mcp/runtime/frink-tools-server';
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

/** A call to Frink's own server, as Cursor's run reports every MCP call. */
const frinkArgsSchema = z.object({
  providerIdentifier: z.literal(FRINK_MCP_KEY),
  toolName: z.string(),
  args: z.record(z.string(), z.json()).default({}),
});
// Text only: an image a Frink tool returns reaches the chat as its own card.
const frinkResultSchema = z.object({
  status: z.literal('success'),
  value: z.object({
    content: z.array(z.object({ text: z.object({ text: z.string() }).optional() })),
    isError: z.boolean().default(false),
  }),
});

/** A Frink tool's result: its text blocks, or an error when the call failed or was unreadable. */
function frinkOutput(
  toolCallId: string,
  parsed: z.infer<typeof frinkResultSchema> | undefined,
): UIMessageChunk {
  const text = parsed?.value.content
    .flatMap((item) => (item.text ? [item.text.text] : []))
    .join('');
  if (parsed && !parsed.value.isError) {
    return { type: 'tool-output-available', toolCallId, output: frinkToolOutput(text ?? '') };
  }
  return { type: 'tool-output-error', toolCallId, errorText: text || TOOL_FAILED };
}

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

type CursorToolCall = Extract<CursorSdkMessage, { type: 'tool_call' }>;

function toolStart(
  state: CursorEventState,
  toolCallId: string,
  toolName: string,
  input: Extract<UIMessageChunk, { type: 'tool-input-available' }>['input'],
): UIMessageChunk[] {
  return [
    ...endTextRun(state),
    { type: 'tool-input-start', toolCallId, toolName },
    { type: 'tool-input-available', toolCallId, toolName, input },
  ];
}

/** A tool call starting or ending; Frink's own tools keep their real names and output. */
function toolCallChunks(message: CursorToolCall, state: CursorEventState): UIMessageChunk[] {
  const { call_id: toolCallId, name } = message;
  const running = message.status === 'running';
  const frink = name === 'mcp' ? frinkArgsSchema.safeParse(message.args).data : undefined;
  if (frink && !running) {
    return [frinkOutput(toolCallId, frinkResultSchema.safeParse(message.result).data)];
  }
  if (frink) return toolStart(state, toolCallId, frinkToolPartName(frink.toolName), frink.args);
  if (!running) return [toolOutput(toolCallId, resultSchema.safeParse(message.result).data)];
  const input = toolCard(name, argsSchema.safeParse(message.args).data ?? {});
  return toolStart(state, toolCallId, CARDS.get(name) ?? GENERIC_TOOL_NAME, input);
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
    case 'tool_call':
      return toolCallChunks(message, state);
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
