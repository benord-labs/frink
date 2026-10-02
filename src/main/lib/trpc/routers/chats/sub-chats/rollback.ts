import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import {
  clearStreamId as clearStreamIdLocal,
  getSubChatById as getSubChatByIdLocal,
  updateSubChatMessages as updateSubChatMessagesLocal,
  updateSubChatSession as updateSubChatSessionLocal,
} from '../../../../db/repos/sub-chats';
import { applyRollbackStash, type RollbackResult } from '../../../../git/stash';
import { publicProcedureRaw, router } from '../../../index';
import {
  findRollbackCheckpoint,
  findRollbackTarget,
  type RollbackTarget,
  truncateForRollback,
} from './rollback-transcript';

export function getRollbackFailureMessage(result: RollbackResult): string | null {
  if (!result.success) {
    return 'Git rollback failed';
  }
  return null;
}

const rollbacksInFlight = new Set<string>();

type RollbackInput = RollbackTarget & {
  subChatId: string;
  mode: 'chat' | 'chat-and-code';
};

type RollbackOutcome =
  | { success: false; error: string }
  | { success: true; messages: unknown[]; gitReverted: boolean };

async function rollbackToMessage(input: RollbackInput): Promise<RollbackOutcome> {
  const db = getDatabase();
  const target: RollbackTarget = {
    userMessageId: input.userMessageId,
    sdkMessageUuid: input.sdkMessageUuid,
  };
  // Read failures propagate (docs/decisions/sub-chat-read-failure-posture.md). This pre-read only
  // picks the git checkpoint; the transcript is truncated from the fresh row after the git await.
  const subChat = await getSubChatByIdLocal(db, input.subChatId);
  if (!subChat) {
    return { success: false, error: 'Sub-chat not found' };
  }

  const lookup = findRollbackTarget(subChat.messages, target);
  if ('error' in lookup) {
    return { success: false, error: lookup.error };
  }

  let gitReverted = false;
  let checkpointUuid: string | undefined;
  if (input.mode === 'chat-and-code') {
    checkpointUuid = findRollbackCheckpoint(subChat.messages, target, lookup.index);

    if (checkpointUuid) {
      const chat = await getChatByIdLocal(db, subChat.chatId);
      if (chat?.worktreePath) {
        const res = await applyRollbackStash(chat.worktreePath, checkpointUuid);
        if (!res.success) {
          log.error('[Sub-chat Rollback] Git rollback failed', {
            subChatId: input.subChatId,
            checkpointUuid,
            error: res.error,
          });
        } else if (!res.checkpointFound) {
          log.warn('[Sub-chat Rollback] Checkpoint not found — reverting chat only', {
            subChatId: input.subChatId,
            checkpointUuid,
          });
        } else {
          gitReverted = true;
        }
        const rollbackFailure = getRollbackFailureMessage(res);
        if (rollbackFailure) {
          return { success: false, error: rollbackFailure };
        }
      }
    }
  }

  // Re-validate after the git await and BEFORE any teardown write, so a vanished target never
  // strands an intact transcript without its session.
  const current = await getSubChatByIdLocal(db, input.subChatId);
  if (!current) {
    return { success: false, error: 'Sub-chat not found' };
  }
  if ('error' in findRollbackTarget(current.messages, target)) {
    return targetVanished(input.subChatId, checkpointUuid, gitReverted);
  }

  // ORDER IS LOAD-BEARING (f655a8): stream teardown first, transcript last — rationale in
  // rollback-router.test.ts "writes stream teardown first and the transcript last".
  await clearStreamIdLocal(db, input.subChatId);
  // updateSubChatSession requires a non-null string in current signature; pass empty
  // string and let the column hold "" (Drizzle accepts it). Renderer treats empty as none.
  await updateSubChatSessionLocal(db, input.subChatId, '', 'rollback');

  let targetGone = false;
  const updated = await updateSubChatMessagesLocal(db, input.subChatId, (fresh) => {
    const next = truncateForRollback(fresh, target);
    if (!next) targetGone = true;
    return next;
  });

  if (!updated) {
    return { success: false, error: 'Sub-chat not found' };
  }
  if (targetGone) {
    // Defensive: only a rollback removes messages, and the in-flight guard serializes those.
    return targetVanished(input.subChatId, checkpointUuid, gitReverted);
  }

  return { success: true, messages: updated.messages, gitReverted };
}

function targetVanished(
  subChatId: string,
  checkpointUuid: string | undefined,
  gitReverted: boolean,
): RollbackOutcome {
  log.error('[Sub-chat Rollback] Target vanished during the rollback', {
    subChatId,
    checkpointUuid,
    gitReverted,
  });
  return {
    success: false,
    error: 'Message no longer exists — code may already have been reverted',
  };
}

/**
 * Phase 1 local-first migration: rollback writes to local SQLite directly.
 * Git side-effects (applyRollbackStash) are unchanged — they were already local.
 */
export const subChatRollbackRouter = router({
  // Raw: `messages` is the stored transcript, read verbatim like getSubChatMessages (see get.ts).
  rollbackToMessage: publicProcedureRaw
    .input(
      z
        .object({
          subChatId: z.string(),
          sdkMessageUuid: z.string().optional(),
          userMessageId: z.string().optional(),
          mode: z.enum(['chat', 'chat-and-code']).default('chat-and-code'),
        })
        .refine((d) => d.sdkMessageUuid || d.userMessageId, {
          message: 'Either sdkMessageUuid or userMessageId is required',
        }),
    )
    .mutation(async ({ input }): Promise<RollbackOutcome> => {
      // One rollback per sub-chat across all panes/windows, or git and transcript diverge. Not
      // withSubChatLock: it is not re-entrant and the repo calls below take it.
      if (rollbacksInFlight.has(input.subChatId)) {
        return { success: false, error: 'Rollback already in progress' };
      }
      rollbacksInFlight.add(input.subChatId);
      try {
        return await rollbackToMessage(input);
      } finally {
        rollbacksInFlight.delete(input.subChatId);
      }
    }),
});
