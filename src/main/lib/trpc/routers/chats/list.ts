import { z } from 'zod';
import { getDatabase } from '../../../db';
import {
  countChatsByProject,
  listAllArchivedChats as listAllArchivedChatsLocal,
  listAllChats as listAllChatsLocal,
  listChatsForProject,
  listPinnedChatsForProjects,
  pageChatsForProjects,
} from '../../../db/repos/chats';
import { getBatchIdByChatId, listChatsByBatch } from '../../../db/repos/flow-runs';
import { listSidebarActiveChats } from '../../../db/repos/task-queries/sidebar-active-chats';
import { listSidebarBatchGroups } from '../../../flows/batch-summaries';
import { publicProcedure, publicProcedureRaw, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';

/**
 * Local-first migration: every chat read here is local SQLite — including batch grouping.
 * `listBatchGroups` + `listByBatch` aggregate local `flow_runs`. See
 * docs/decisions/renderer-structure-governance for the source-of-truth ruling.
 */

/**
 * Attach each chat's `batchId`, derived from local `flow_runs` (the chat↔run link is JSON-only —
 * see `getBatchIdByChatId`). `mapLocalChatResponse` defaults `batchId` to null because the local
 * chats table has no batch column; the sidebar needs it to fold a Flow's batch runs into one group.
 */
async function withBatchIds<T extends { id: string; batchId: string | null }>(
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const batchByChatId = await getBatchIdByChatId(getDatabase());
  if (batchByChatId.size === 0) return rows;
  return rows.map((row) => {
    const batchId = batchByChatId.get(row.id);
    return batchId ? { ...row, batchId } : row;
  });
}

export const listRouter = router({
  list: publicProcedure
    .input(z.object({ projectId: z.string().nullable().optional() }))
    .query(async ({ input }) => {
      // input.projectId === undefined → list all chats across projects
      // input.projectId === null      → list general (no-project) chats only
      // input.projectId === string    → list chats for that project
      const rows =
        input.projectId === undefined
          ? await listAllChatsLocal(getDatabase())
          : await listChatsForProject(getDatabase(), input.projectId);
      return rows.map(mapLocalChatResponse);
    }),

  listArchived: publicProcedure.query(async () => {
    const rows = await listAllArchivedChatsLocal(getDatabase());
    return rows.map(mapLocalChatResponse);
  }),

  listCounts: publicProcedure.query(async () => {
    return countChatsByProject(getDatabase());
  }),

  // Active chats with their folder and batch, loaded in the sidebar or not, so a collapsed folder can
  // show their activity. Status still comes from the task poll; this read only places chats.
  listActiveChats: publicProcedure.query(async () => listSidebarActiveChats(getDatabase())),

  listByFolder: publicProcedure
    .input(
      z.object({
        projectIds: z.array(z.string()).nullable(),
        limit: z.number().min(1).max(100).default(30),
        cursor: z
          .object({
            updatedAt: z.string(),
            id: z.string(),
          })
          .nullable()
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const projectIds = input.projectIds === null ? [null] : input.projectIds;
      const cursor = input.cursor
        ? { updatedAt: new Date(input.cursor.updatedAt), id: input.cursor.id }
        : undefined;

      const rows = await pageChatsForProjects(getDatabase(), {
        projectIds,
        limit: input.limit + 1,
        cursor,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page.at(-1);

      return {
        chats: await withBatchIds(page.map(mapLocalChatResponse)),
        hasMore,
        nextCursor: last
          ? {
              updatedAt: (last.updatedAt ?? new Date()).toISOString(),
              id: last.id,
            }
          : null,
      };
    }),

  /**
   * Local: batch summaries aggregated from local flow_runs. Raw (no
   * caseConvert) — `SidebarBatchGroup` is snake_case end-to-end; the sidebar keys its group map on
   * `group.batch_id`, so camelCasing it would null the key and silently un-group every batch.
   */
  listBatchGroups: publicProcedureRaw.query(async () => {
    return listSidebarBatchGroups(getDatabase());
  }),

  /** Local: chats in an expanded batch row, resolved via the flow_runs chat link. */
  listByBatch: publicProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .query(async ({ input }) => {
      const rows = await listChatsByBatch(getDatabase(), input.batchId);
      return rows.map((row) => ({ ...mapLocalChatResponse(row), batchId: input.batchId }));
    }),

  listPinned: publicProcedure
    .input(z.object({ projectIds: z.array(z.string()).nullable() }))
    .query(async ({ input }) => {
      const projectIds = input.projectIds === null ? [null] : input.projectIds;
      const rows = await listPinnedChatsForProjects(getDatabase(), projectIds);
      return withBatchIds(rows.map(mapLocalChatResponse));
    }),
});
