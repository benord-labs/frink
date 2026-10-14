import type { SessionEvent, ToolExecutionStartData } from '@github/copilot-sdk';
import { z } from 'zod';
import type { UIMessageChunk } from '../../claude/types';

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

/** What one turn has streamed so far. */
export type CopilotEventState = {
  openTextId: string | null;
  inputTokens: number;
  outputTokens: number;
};

export function createCopilotEventState(): CopilotEventState {
  return { openTextId: null, inputTokens: 0, outputTokens: 0 };
}

/** Ends the open text run, so text after a thought or a card starts a new block below it. */
function endTextRun(state: CopilotEventState): UIMessageChunk[] {
  if (state.openTextId === null) return [];
  const id = state.openTextId;
  state.openTextId = null;
  return [{ type: 'text-end', id }];
}

function toolCard(data: ToolExecutionStartData) {
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
    case 'tool.execution_start': {
      const { toolCallId } = event.data;
      const card = toolCard(event.data);
      return [
        ...endTextRun(state),
        { type: 'tool-input-start', toolCallId, toolName: card.toolName },
        { type: 'tool-input-available', toolCallId, ...card },
      ];
    }
    case 'tool.execution_complete': {
      const { toolCallId, success, result, error } = event.data;
      if (success) {
        return [
          { type: 'tool-output-available', toolCallId, output: { output: result?.content ?? '' } },
        ];
      }
      return [{ type: 'tool-output-error', toolCallId, errorText: error?.message ?? TOOL_FAILED }];
    }
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
