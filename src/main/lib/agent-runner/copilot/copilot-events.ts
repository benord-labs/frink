import type { SessionEvent, ToolExecutionStartData } from '@github/copilot-sdk';
import { z } from 'zod';
import { FRINK_MCP_KEY, frinkToolPartName } from '../../../../shared/lib/mcp-tool-name';
import type { UIMessageChunk } from '../../claude/types';
import { frinkToolOutput } from '../../mcp/runtime/frink-tools-server';
import { endTextRun } from '../codex/codex-stream-chunks';
import { PATCH_TOOL, type PatchFile, readPatch } from './copilot-patch';

/** Card for a tool Frink has no dedicated card for. */
const GENERIC_TOOL_NAME = 'AgentTool';
const TOOL_FAILED = 'The tool call failed.';

const cardArgsSchema = z
  .object({
    command: z.string(),
    path: z.string(),
    file_text: z.string(),
    old_str: z.string(),
    new_str: z.string(),
    url: z.string(),
  })
  .partial();

type ToolCard = Pick<
  Extract<UIMessageChunk, { type: 'tool-input-available' }>,
  'toolName' | 'input'
>;

/** What one turn has streamed so far. */
export type CopilotEventState = {
  openTextId: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Calls shown as more than one card, such as a patch shown file by file. */
  cardCounts: Map<string, number>;
  /** Calls to Frink's own tools, whose results show as Frink's cards read them. */
  frinkCalls: Set<string>;
};

export function createCopilotEventState(): CopilotEventState {
  return {
    openTextId: null,
    inputTokens: 0,
    outputTokens: 0,
    cardCounts: new Map(),
    frinkCalls: new Set(),
  };
}

/** The first card keeps the call's id; later ones use `#`, as `:` marks a part nested in a subagent. */
const cardId = (toolCallId: string, index: number) =>
  index === 0 ? toolCallId : `${toolCallId}#${index}`;

/** The patch lines carrying `mark`, without it. */
const marked = (lines: string[], mark: '+' | '-') =>
  lines
    .filter((line) => line.startsWith(mark))
    .map((line) => line.slice(1))
    .join('\n');

/** A moved file shows as its old name deleted and its new name edited. */
function patchCard({ action, file, lines }: PatchFile, next?: PatchFile): ToolCard {
  if (action === 'Delete File' || (action === 'Update File' && next?.action === 'Move to')) {
    return { toolName: 'Delete', input: { file_path: file } };
  }
  if (action === 'Add File') {
    return { toolName: 'Write', input: { file_path: file, content: marked(lines, '+') } };
  }
  const input = { file_path: file, old_string: marked(lines, '-'), new_string: marked(lines, '+') };
  return { toolName: 'Edit', input };
}

function toolCard(data: ToolExecutionStartData): ToolCard {
  if (data.mcpServerName === FRINK_MCP_KEY && data.mcpToolName) {
    const input = z.record(z.string(), z.json()).safeParse(data.arguments).data ?? {};
    return { toolName: frinkToolPartName(data.mcpToolName), input };
  }
  const args = cardArgsSchema.safeParse(data.arguments).data ?? {};
  switch (data.toolName) {
    case 'bash':
      return { toolName: 'Bash', input: { command: args.command } };
    case 'create':
      return {
        toolName: 'Edit',
        input: { file_path: args.path, old_string: '', new_string: args.file_text },
      };
    case 'edit':
      return {
        toolName: 'Edit',
        input: { file_path: args.path, old_string: args.old_str, new_string: args.new_str },
      };
    case 'view':
      return { toolName: 'Read', input: { file_path: args.path } };
    case 'web_fetch':
      return { toolName: 'WebFetch', input: { url: args.url } };
    default:
      return {
        toolName: GENERIC_TOOL_NAME,
        input: { description: data.toolTitle ?? data.toolName },
      };
  }
}

/** One card per file a readable patch names; one card for any other call. */
function toolCards(data: ToolExecutionStartData): ToolCard[] {
  const patch = z.string().safeParse(data.arguments);
  const files = data.toolName === PATCH_TOOL && patch.success ? readPatch(patch.data) : undefined;
  return files?.map((file, index) => patchCard(file, files[index + 1])) ?? [toolCard(data)];
}

type ToolEndData = Extract<SessionEvent, { type: 'tool.execution_complete' }>['data'];

function toolStartChunks(data: ToolExecutionStartData, state: CopilotEventState): UIMessageChunk[] {
  const cards = toolCards(data);
  if (cards.length > 1) state.cardCounts.set(data.toolCallId, cards.length);
  if (data.mcpServerName === FRINK_MCP_KEY) state.frinkCalls.add(data.toolCallId);
  return [
    ...endTextRun(state),
    ...cards.flatMap((card, index): UIMessageChunk[] => {
      const toolCallId = cardId(data.toolCallId, index);
      return [
        { type: 'tool-input-start', toolCallId, toolName: card.toolName },
        { type: 'tool-input-available', toolCallId, ...card },
      ];
    }),
  ];
}

function toolEndChunks(data: ToolEndData, state: CopilotEventState): UIMessageChunk[] {
  const { success, result, error } = data;
  const count = state.cardCounts.get(data.toolCallId) ?? 1;
  state.cardCounts.delete(data.toolCallId);
  // Text only: an image a Frink tool returns reaches the chat as its own card.
  const text = result?.content ?? '';
  const frink = state.frinkCalls.delete(data.toolCallId);
  return Array.from({ length: count }, (_, index): UIMessageChunk => {
    const toolCallId = cardId(data.toolCallId, index);
    if (success) {
      const output = frink ? frinkToolOutput(text) : { output: text };
      return { type: 'tool-output-available', toolCallId, output };
    }
    return { type: 'tool-output-error', toolCallId, errorText: error?.message ?? TOOL_FAILED };
  });
}

/** Maps one Copilot session event onto Frink's chat chunks. Events Frink does not show map to none. */
export function mapCopilotEvent(event: SessionEvent, state: CopilotEventState): UIMessageChunk[] {
  switch (event.type) {
    case 'assistant.message_delta': {
      // A helper agent's own words reach its parent as the result of its tool call.
      if (event.agentId) return [];
      const { messageId, deltaContent } = event.data;
      const ended = state.openTextId === messageId ? [] : endTextRun(state);
      state.openTextId = messageId;
      return [...ended, { type: 'text-delta', id: messageId, delta: deltaContent }];
    }
    case 'assistant.reasoning_delta': {
      if (event.agentId) return [];
      const { reasoningId, deltaContent } = event.data;
      return [
        ...endTextRun(state),
        { type: 'reasoning-delta', id: reasoningId, delta: deltaContent },
      ];
    }
    case 'tool.execution_start':
      return toolStartChunks(event.data, state);
    case 'tool.execution_complete':
      return toolEndChunks(event.data, state);
    case 'assistant.usage': {
      state.inputTokens += event.data.inputTokens ?? 0;
      state.outputTokens += event.data.outputTokens ?? 0;
      const { inputTokens, outputTokens } = state;
      return [
        {
          type: 'message-metadata',
          messageMetadata: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        },
      ];
    }
    case 'session.error':
      return event.agentId ? [] : [{ type: 'error', errorText: event.data.message }];
    default:
      return [];
  }
}
