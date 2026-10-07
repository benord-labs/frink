import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { trackWorkspaceArchived } from '../../../analytics';
import { getDatabase } from '../../../db';
import {
  archiveChat as archiveChatLocal,
  getChatById as getChatByIdLocal,
  unarchiveChat as unarchiveChatLocal,
  updateChat as updateChatLocal,
} from '../../../db/repos/chats';
import { listSubChatsByChat as listSubChatsByChatLocal } from '../../../db/repos/sub-chats';
import type { ArchiveChatResult } from '../../../db/repos/task-queries/chat-archive-tasks';
import { cancelFlowRunsForChat } from '../../../flows';
import { gitCache } from '../../../git/cache';
import { abortActiveExecutionsForSubChats, clearCodexSession } from '../../../socket/executor';
import { stopTaskSession } from '../../../tasks/abort-task-session';
import { terminalManager } from '../../../terminal/manager';
import { publicProcedure, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';
import { type ChatWorktreeRef, tearDownChatWorktree } from './teardown-worktree';

type Db = ReturnType<typeof getDatabase>;

/** Running worktree teardowns by chat id, so restore can wait one out instead of racing it. */
const teardownsInFlight = new Map<string, Promise<void>>();

function invalidateWorktreeCaches(worktreePath: string | null): void {
  if (!worktreePath) return;
  gitCache.invalidateStatus(worktreePath);
  gitCache.invalidateParsedDiff(worktreePath);
}

async function tearDownArchivedWorktree(db: Db, ref: ChatWorktreeRef): Promise<void> {
  const current = await getChatByIdLocal(db, ref.id).catch(() => null);
  if (!current?.archivedAt) return;
  const removed = await tearDownChatWorktree(db, ref);
  if (removed) await updateChatLocal(db, ref.id, { worktreePath: null }).catch(() => {});
}

/**
 * Remove an archived chat's worktree in the background, then drop the now-dangling worktreePath.
 *
 * `removeWorktree` runs with `--force` and no dirty-work check, and archiving is undoable, so this
 * is registered rather than fired blind: `restore` awaits the registered promise before it
 * unarchives. That makes the two mutually exclusive — a restore either lands first (the archived
 * re-read below then declines the removal) or waits and reports a row that matches what actually
 * survived. Re-archiving while one is running joins the existing teardown instead of starting a
 * second removal of the same path.
 */
function startArchivedWorktreeTeardown(db: Db, ref: ChatWorktreeRef): void {
  if (teardownsInFlight.has(ref.id)) return;
  const running = tearDownArchivedWorktree(db, ref).finally(() => {
    teardownsInFlight.delete(ref.id);
  });
  teardownsInFlight.set(ref.id, running);
}

/** Sessions stop only after the archive commits, as the Work Queue's Cancel does. Throws on failure. */
function archiveChatStoppingTasks(db: Db, chatId: string): ArchiveChatResult {
  const result = archiveChatLocal(db, chatId);
  for (const previous of result.cancelledPrevious) stopTaskSession(previous);
  return result;
}

/**
 * Chat archive operations.
 *
 * Phase 1 local-first migration: archive/restore now write to local SQLite directly.
 * Worktree teardown still uses the local git tooling.
 */
export const archiveRouter = router({
  archive: publicProcedure
    .input(
      z.object({
        id: z.string(),
        deleteWorktree: z.boolean().default(false),
        killTerminals: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();

      // Read chat row before flipping archived_at so we can drive worktree cleanup off it.
      const chat = await getChatByIdLocal(db, input.id).catch((error) => {
        log.warn('[chats.archive] getChatById failed', error);
        return null;
      });

      // Phase 1 ship-blocker fix (commits 6056c8 / 6112ec): abort active executions for
      // this chat's sub-chats BEFORE flipping archived_at + tearing down the worktree.
      // Otherwise the SDK keeps streaming + tool-calling against a worktree that's about
      // to vanish. Mirrors the delete path.
      // Null (not []) when the lookup fails: an empty abort is indistinguishable from "nothing was
      // running", and we must not force-remove a worktree an agent may still be streaming into.
      let abortedSubChats = chat !== null;
      if (chat) {
        const subChats = await listSubChatsByChatLocal(db, chat.id).catch(() => null);
        abortedSubChats = subChats !== null;
        abortActiveExecutionsForSubChats(
          (subChats ?? []).map((sc) => sc.id),
          'chat archived',
        );
        // Archiving removes the chat from view and can tear down its worktree — stop the
        // flow runs it drives too, same as delete (else the run keeps going / the worktree
        // is yanked from under a live flow agent).
        await cancelFlowRunsForChat(chat.id);
      }
      clearCodexSession(input.id);

      let archivedChat: ArchiveChatResult['chat'];
      try {
        archivedChat = archiveChatStoppingTasks(db, input.id).chat;
      } catch (error) {
        log.warn('[chats.archive] archive with linked-task cancel failed', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: "Could not stop this chat's task, so the chat was not archived.",
          cause: error,
        });
      }

      trackWorkspaceArchived(input.id);

      if (input.killTerminals) {
        terminalManager.killByWorkspaceId(input.id).catch(() => {
          // Terminal kill failed; don't block archive
        });
      }

      // Optional worktree removal in background (only when the user opted to delete it; forked
      // chats are protected by the helper's tri-state sibling check + retrying removal). Terminals
      // were killed above. Skipped when the sub-chat lookup failed, since we can't then prove no
      // agent is still streaming into it. Failures are reclaimed by the boot sweep.
      if (
        input.deleteWorktree &&
        abortedSubChats &&
        chat?.worktreePath &&
        chat?.branch &&
        chat?.projectId
      ) {
        startArchivedWorktreeTeardown(db, {
          id: input.id,
          worktreePath: chat.worktreePath,
          branch: chat.branch,
          projectId: chat.projectId,
        });
      }

      invalidateWorktreeCaches(chat?.worktreePath ?? null);

      return archivedChat ? mapLocalChatResponse(archivedChat) : null;
    }),

  restore: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Settle any running teardown first so we never unarchive into a `--force` removal that is
    // already underway; the restored row then reflects whether the worktree actually survived.
    await teardownsInFlight.get(input.id)?.catch(() => {});
    const restored = await unarchiveChatLocal(getDatabase(), input.id);
    return restored ? mapLocalChatResponse(restored) : null;
  }),

  archiveBatch: publicProcedure
    .input(z.object({ chatIds: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      // Multi-select can hand the same id over more than once; dedupe so a chat isn't archived
      // twice and echoed back as a duplicate row.
      const chatIds = [...new Set(input.chatIds)];
      if (chatIds.length === 0) return [];
      const db = getDatabase();

      // Phase 1 ship-blocker fix: abort each chat's active executions before flipping
      // archived_at, same reasoning as the single-chat path above.
      const allSubChatIds: string[] = [];
      for (const chatId of chatIds) {
        const subChats = await listSubChatsByChatLocal(db, chatId).catch(() => []);
        allSubChatIds.push(...subChats.map((sc) => sc.id));
      }
      abortActiveExecutionsForSubChats(allSubChatIds, 'chat archived (batch)');
      for (const chatId of chatIds) await cancelFlowRunsForChat(chatId);

      // Per chat, so one chat whose task can't be stopped doesn't hold back the rest.
      const archivedChats = chatIds.map((chatId) => {
        try {
          return archiveChatStoppingTasks(db, chatId).chat;
        } catch (error) {
          log.warn('[chats.archiveBatch] archive with linked-task cancel failed', {
            chatId,
            error,
          });
          return null;
        }
      });
      const result = archivedChats.filter(
        (chat): chat is NonNullable<typeof chat> => chat !== null,
      );

      for (const id of chatIds) clearCodexSession(id);
      // Same staleness the single-chat path clears: an archived chat's cached status/diff must not
      // outlive it in the sidebar.
      for (const chat of result) invalidateWorktreeCaches(chat.worktreePath);

      Promise.all(chatIds.map((id) => terminalManager.killByWorkspaceId(id))).catch(() => {
        // Terminal kill failed
      });

      return result.map(mapLocalChatResponse);
    }),
});
