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
import { cancelFlowRunsForChat } from '../../../flows';
import { gitCache } from '../../../git/cache';
import {
  abortActiveExecutionsForChat,
  abortActiveExecutionsForSubChats,
  clearCodexSession,
} from '../../../socket/executor';
import { doomAdmissionsForChat } from '../../../socket/streaming/execution-registry';
import { terminalManager } from '../../../terminal/manager';
import { publicProcedure, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';
import { type ChatWorktreeRef, tearDownChatWorktree } from './teardown-worktree';

type Db = ReturnType<typeof getDatabase>;

/** Running worktree teardowns by chat id, so restore can wait one out instead of racing it. */
const teardownsInFlight = new Map<string, Promise<void>>();

/** Archives in flight per chat, chained so overlapping ones are all waited for: a restore landing
 * mid-archive would be overwritten by its write. */
const archivesInFlight = new Map<string, Promise<unknown>>();

function trackArchive<T>(chatIds: readonly string[], run: Promise<T>): Promise<T> {
  for (const chatId of chatIds) {
    const pending: Promise<unknown> = Promise.allSettled([archivesInFlight.get(chatId), run]).then(
      () => {
        if (archivesInFlight.get(chatId) === pending) archivesInFlight.delete(chatId);
      },
    );
    archivesInFlight.set(chatId, pending);
  }
  return run;
}

/** Once archived_at has landed: doom sends still mid-admission (they may hold the pre-archive row),
 * and abort runs that registered since the pre-write sweep. */
function stopLateRuns(chatId: string, reason: string): void {
  doomAdmissionsForChat(chatId);
  abortActiveExecutionsForChat(chatId, reason);
}

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

type ArchiveInput = { id: string; deleteWorktree: boolean; killTerminals: boolean };

async function archiveOne(input: ArchiveInput) {
  const db = getDatabase();

  // Read chat row before flipping archived_at so we can drive worktree cleanup off it.
  const chat = await getChatByIdLocal(db, input.id).catch((error) => {
    log.warn('[chats.archive] getChatById failed', error);
    return null;
  });

  // Abort the sub-chats' runs BEFORE archiving/teardown (as delete does). A failed lookup must not
  // read as "nothing running": teardown is then skipped, as an agent may still stream into it.
  let abortedSubChats = chat !== null;
  if (chat) {
    const subChats = await listSubChatsByChatLocal(db, chat.id).catch(() => null);
    abortedSubChats = subChats !== null;
    abortActiveExecutionsForSubChats(
      (subChats ?? []).map((sc) => sc.id),
      'chat archived',
    );
    // Stop the flow runs it drives too, as delete does — else they keep going, or lose their
    // worktree mid-run.
    await cancelFlowRunsForChat(chat.id);
  }
  // The registry knows which runs belong to this chat without a DB read, so a failed row or
  // sub-chat lookup above still stops the agent.
  abortActiveExecutionsForChat(input.id, 'chat archived');
  clearCodexSession(input.id);

  const archivedChat = await archiveChatLocal(db, input.id);
  if (archivedChat) stopLateRuns(input.id, 'chat archived');

  trackWorkspaceArchived(input.id);

  if (input.killTerminals) {
    terminalManager.killByWorkspaceId(input.id).catch(() => {
      // Terminal kill failed; don't block archive
    });
  }

  // Opt-in background worktree removal (forks protected by the helper's sibling check), skipped
  // when the sub-chat lookup failed. Failures are reclaimed by the boot sweep.
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
}

async function archiveMany(chatIds: string[]) {
  const db = getDatabase();

  // Phase 1 ship-blocker fix: abort each chat's active executions before flipping
  // archived_at, same reasoning as the single-chat path above.
  const subChatLists = await Promise.all(
    chatIds.map((chatId) => listSubChatsByChatLocal(db, chatId).catch(() => [])),
  );
  abortActiveExecutionsForSubChats(
    subChatLists.flat().map((sc) => sc.id),
    'chat archived (batch)',
  );
  // Registry sweep: covers a chat whose sub-chat lookup failed above (see single-chat path).
  for (const chatId of chatIds) abortActiveExecutionsForChat(chatId, 'chat archived (batch)');
  await Promise.all(chatIds.map((chatId) => cancelFlowRunsForChat(chatId)));

  // Each chat stops its late runs as soon as its own write lands; allSettled so one failed write
  // cannot settle the batch while siblings are still writing.
  const writes = await Promise.allSettled(
    chatIds.map(async (chatId) => {
      const chat = await archiveChatLocal(db, chatId);
      if (chat) stopLateRuns(chatId, 'chat archived (batch)');
      return chat;
    }),
  );
  const failed = writes.find((write) => write.status === 'rejected');
  const result = writes.flatMap((write) =>
    write.status === 'fulfilled' && write.value ? [write.value] : [],
  );

  for (const id of chatIds) clearCodexSession(id);
  // Same staleness the single-chat path clears: an archived chat's cached status/diff must not
  // outlive it in the sidebar.
  for (const chat of result) invalidateWorktreeCaches(chat.worktreePath);

  Promise.all(chatIds.map((id) => terminalManager.killByWorkspaceId(id))).catch(() => {
    // Terminal kill failed
  });

  if (failed) throw failed.reason;
  return result.map(mapLocalChatResponse);
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
    .mutation(({ input }) => trackArchive([input.id], archiveOne(input))),

  restore: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Settle running archives (see archivesInFlight), then any teardown: never unarchive into a
    // `--force` removal already underway, so the restored row reflects what actually survived.
    await archivesInFlight.get(input.id);
    await teardownsInFlight.get(input.id)?.catch(() => {});
    const restored = await unarchiveChatLocal(getDatabase(), input.id);
    return restored ? mapLocalChatResponse(restored) : null;
  }),

  /** How the chat's archive ended, once any archive still in flight settles (renderer reload). */
  archiveOutcome: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    await archivesInFlight.get(input.id);
    const chat = await getChatByIdLocal(getDatabase(), input.id);
    return chat ? { archived: chat.archivedAt !== null } : null;
  }),

  archiveBatch: publicProcedure
    .input(z.object({ chatIds: z.array(z.string()) }))
    .mutation(({ input }) => {
      // Multi-select can hand the same id over more than once; dedupe so a chat isn't archived
      // twice and echoed back as a duplicate row.
      const chatIds = [...new Set(input.chatIds)];
      if (chatIds.length === 0) return Promise.resolve([]);
      return trackArchive(chatIds, archiveMany(chatIds));
    }),
});
