import type { Message } from '../../../../db/repos/sub-chats';

/** What a rollback points at: a user message (truncated EXCLUDING it) or an SDK turn (INCLUDING it). */
export type RollbackTarget = { userMessageId?: string; sdkMessageUuid?: string };

export type RollbackTargetLookup = { index: number } | { error: string };

function sdkUuidOf(message: Message): unknown {
  return (message.metadata as Record<string, unknown> | undefined)?.sdkMessageUuid;
}

/**
 * Locate the rollback target. Pure so it can run twice: once against the pre-read (to pick the
 * git checkpoint) and again inside the write lock against the fresh row.
 */
export function findRollbackTarget(
  messages: Message[],
  target: RollbackTarget,
): RollbackTargetLookup {
  let index = -1;
  if (target.userMessageId) {
    index = messages.findIndex((m) => m.id === target.userMessageId);
  } else if (target.sdkMessageUuid) {
    index = messages.findIndex((m) => sdkUuidOf(m) === target.sdkMessageUuid);
  }
  if (index === -1) return { error: 'Message not found' };

  // user-message rollback truncates EXCLUDING the target and walks back for the checkpoint —
  // applying that path to a non-user message would corrupt history and pick a wrong checkpoint.
  if (target.userMessageId && messages[index].role !== 'user') {
    return { error: 'userMessageId must reference a user message' };
  }
  return { index };
}

/**
 * The checkpoint a rollback reverts the worktree to: the target's own SDK uuid, or — for a user
 * message — the nearest preceding message that carries one. Undefined when there is none.
 */
export function findRollbackCheckpoint(
  messages: Message[],
  target: RollbackTarget,
  index: number,
): string | undefined {
  if (target.sdkMessageUuid) return target.sdkMessageUuid;
  for (let i = index - 1; i >= 0; i--) {
    const uuid = sdkUuidOf(messages[i]);
    if (uuid) return uuid as string;
  }
  return undefined;
}

/**
 * The rolled-back transcript, computed from `messages` (the fresh row, when called under the
 * write lock). Null when the target is no longer present or no longer valid.
 */
export function truncateForRollback(messages: Message[], target: RollbackTarget): Message[] | null {
  const lookup = findRollbackTarget(messages, target);
  if ('error' in lookup) return null;

  const sliceEnd = target.userMessageId ? lookup.index : lookup.index + 1;
  const truncated = messages.slice(0, sliceEnd);

  // claude.ts resume logic looks for shouldResume on the last *assistant* message,
  // so we must place it there even when the truncation target is a user message.
  let resumeIndex = -1;
  for (let i = truncated.length - 1; i >= 0; i--) {
    if (truncated[i].role === 'assistant') {
      resumeIndex = i;
      break;
    }
  }

  return truncated.map((msg, i) => {
    const metadata = (msg.metadata as Record<string, unknown>) || {};
    const { shouldResume: _, ...restMeta } = metadata;
    return {
      ...msg,
      metadata: {
        ...restMeta,
        ...(i === resumeIndex && { shouldResume: true }),
      },
    };
  });
}
