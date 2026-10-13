import type { PromptResponse, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { UIMessageChunk } from '../../claude/types';

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
type AcpTurnState = {
  openTextId: string | null;
  textRuns: number;
};

export function createAcpTurnState(): AcpTurnState {
  return { openTextId: null, textRuns: 0 };
}

/** Ends the open text run, so text after a thought starts a new block below it. */
function endTextRun(state: AcpTurnState): UIMessageChunk[] {
  if (state.openTextId === null) return [];
  const id = state.openTextId;
  state.openTextId = null;
  return [{ type: 'text-end', id }];
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
