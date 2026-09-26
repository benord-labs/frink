import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import {
  emitCodexSteerMarker,
  getCodexLiveTurn,
  steerCodexTurn,
} from '../../agent-runner/codex/codex-live-turn';
import { pendingToolApprovals } from '../../claude/ask-user-question-approval';
import type { UIMessageChunk } from '../../claude/types';
import { captureMainException } from '../../sentry/init';
import { buildClaudeUserMessage } from '../claude-input-queue';
import { getSession } from '../claude-session-registry';
import type { ClaudeTurnContext } from '../claude-turn-context';
import { emitSteerMarker } from './emitter';

/**
 * The steer's own trace in the transcript, rendered as a card INSIDE the running assistant message.
 *
 * Reuses the `tool-input-available` shape that already carries non-tool content inline (the
 * Thinking card does the same), so the marker rides the existing parts/persist/render pipeline with
 * no new part type. It must not open a NEW assistant message: `live-run-observer-lane` rules that
 * one turn is one assistant message, because the renderer applies its end-of-turn treatment per
 * message and a split turn reads as several half-finished answers.
 *
 * Emitted when the steer is ACCEPTED, not when the model reads it — the CLI never announces the
 * dequeue, so the marker honestly records when the user said it.
 */
function steerMarkerChunk(text: string): UIMessageChunk {
  return {
    type: 'tool-input-available',
    toolCallId: `steer-${randomUUID()}`,
    toolName: 'Steer',
    input: { text },
    providerExecuted: true,
  } as UIMessageChunk;
}

/**
 * `delivered`     — the running turn accepted it; the agent reads it at its next model invocation.
 * `not-steerable` — nothing steerable is running (idle, blocked on a permission prompt, or a turn
 *                   kind that refuses steering). The CALLER MUST QUEUE the message.
 * `unsupported`   — this runtime has no steer channel at all (e.g. an old codex binary).
 *                   Also queue.
 */
export type SteerOutcome = 'delivered' | 'not-steerable' | 'unsupported';

export type SteerMessage = {
  text: string;
  imageParts?: Array<{ mediaType: string; base64Data: string }>;
};

/**
 * True while this sub-chat is blocked inside `canUseTool` waiting on a human.
 *
 * `session.busy` cannot tell "sampling" apart from "parked on a permission prompt /
 * AskUserQuestion", and the difference decides whether a steer can ever be read: a parked CLI
 * reaches no next model invocation, so the message would sit unread for up to
 * PERMISSION_PROMPT_TIMEOUT_MS and then be destroyed outright when a timed-out flow question
 * interrupts the query. Queue it rather than promise a delivery that cannot happen.
 */
function hasOpenApproval(subChatId: string): boolean {
  for (const pending of pendingToolApprovals.values()) {
    if (pending.subChatId === subChatId) return true;
  }
  return false;
}

/** Push onto the live Claude session's input queue WITHOUT starting a turn. */
function steerClaudeTurn(subChatId: string, message: SteerMessage): SteerOutcome {
  const session = getSession(subChatId);
  // `busy` covers a user turn AND a wake burst — in both the agent is genuinely working and will
  // reach another model invocation, which is steering's only precondition.
  if (!session?.busy || session.queue.closed) return 'not-steerable';
  // A turn still awaiting its pre-push reconcile has no prompt queued; a steer would overtake it.
  const turn = session.loop.turn;
  if (turn && turn.pushedAt === undefined) return 'not-steerable';
  if (hasOpenApproval(subChatId)) return 'not-steerable';

  // Deliberately NOT runTurn(): that starts a turn and rejects re-entry while one is in flight.
  // A steer is a bare push onto the queue the SDK is already draining. The CLI splices it into the
  // running turn at its next model invocation and still emits exactly ONE `result` for the whole
  // turn (verified against the CLI), so the turn loop needs no knowledge of this.
  session.queue.push(
    buildClaudeUserMessage(message.text, message.imageParts ?? [], 'agent', {
      uuid: randomUUID() as SDKUserMessage['uuid'],
      priority: 'next',
    }),
  );
  if (session.currentTurn) session.currentTurn.steered = true;
  return 'delivered';
}

/**
 * Deliver a message INTO the turn this sub-chat is already running, without aborting it.
 *
 * This is the whole point of the feature, and the reason it must never touch `handleRemoteExecute`:
 * that path's duplicate-request guard aborts the previous execution, which is exactly the
 * destruction steering exists to avoid. For the same reason, a caller that gets anything other than
 * `delivered` must fall back to the message QUEUE and never to a direct send — a direct send hits
 * that same guard and aborts the turn from behind a button labelled Steer.
 */
/**
 * Leave the steer's own trace in the transcript. Resolves the chat id here rather than threading it
 * from the caller: the tRPC surface only knows the sub-chat, and this runs once per steer.
 */
async function markSteerInTranscript(
  subChatId: string,
  text: string,
  /** The turn that was live when the steer was PUSHED, captured before any await. */
  steeredTurn: ClaudeTurnContext,
): Promise<void> {
  try {
    const { getDatabase } = await import('../../db');
    const { getSubChatById } = await import('../../db/repos/sub-chats');
    const subChat = await getSubChatById(getDatabase(), subChatId);
    if (!subChat) return;
    // Guarded on BOTH liveness and identity across the DB await. Identity alone is not enough:
    // a turn's end clears `busy` but deliberately leaves `currentTurn` pointing at the turn
    // that just ended, so an identity-only check still matches a FINALIZED message and would append
    // "You steered" to it. Requiring `busy` too means the marker lands only while the turn it joined
    // is genuinely still streaming. A dropped marker is cosmetic; one on the wrong (or a closed)
    // message misreports what the agent was told.
    const live = getSession(subChatId);
    if (!live?.busy || live.currentTurn !== steeredTurn) return;
    emitSteerMarker(steeredTurn, subChat.chatId, subChatId, steerMarkerChunk(text));
  } catch (err) {
    // Swallowed on purpose — a missing marker must never fail an accepted steer — but swallowed
    // silently it would hide a broken transcript path indefinitely, so it is captured.
    log.warn(`[Steer] could not render the steer marker for ${subChatId}:`, err);
    captureMainException(err, { surface: 'steer', stage: 'marker' });
  }
}

export async function steerActiveTurn(
  subChatId: string,
  message: SteerMessage,
): Promise<SteerOutcome> {
  // Pin the turn SYNCHRONOUSLY, before the push and before any await, so the marker can only ever
  // land on the turn this steer actually joined.
  const steeredTurn = getSession(subChatId)?.currentTurn ?? null;
  const claude = steerClaudeTurn(subChatId, message);
  if (claude === 'delivered') {
    log.info(`[Steer] delivered into the running Claude turn for ${subChatId}`);
    if (steeredTurn) await markSteerInTranscript(subChatId, message.text, steeredTurn);
    return claude;
  }

  // Codex's wire input is text; an image-bearing steer would silently lose its images, so it queues.
  // Codex checks its OWN approval registry inside steerCodexTurn: its approvals are answered in the
  // runner's handler and never reach Claude's pendingToolApprovals, so hasOpenApproval is blind here.
  if (!message.imageParts?.length) {
    // Pinned BEFORE the turn/steer round trip, so the marker can only land on the turn that took it.
    const codexTurnId = getCodexLiveTurn(subChatId)?.turnId;
    const codex = await steerCodexTurn(subChatId, message.text);
    if (codex === 'delivered' && codexTurnId) {
      log.info(`[Steer] delivered into the running Codex turn for ${subChatId}`);
      // Pushed into the turn's own chunk queue: a Codex turn has no ClaudeTurnContext, so it cannot
      // route through the Claude emitter, but the marker must still appear or the user's message
      // vanishes from the transcript on a runtime we do support.
      emitCodexSteerMarker(subChatId, codexTurnId, steerMarkerChunk(message.text));
    }
    if (codex !== 'not-steerable') return codex;
  }

  // With no Claude session and no live Codex turn, main cannot tell "this runtime has no steer
  // channel" from "nothing is running right now", so callers queue on the Claude outcome.
  return claude;
}
