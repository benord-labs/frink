/* eslint-disable max-lines, max-lines-per-function */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { z } from 'zod';
import { trackWorkspaceCreated } from '../../../analytics';
import { getDatabase } from '../../../db';
import {
  createChat as createChatLocal,
  findChatByWorktree as findChatByWorktreeLocal,
  updateChat as updateChatLocal,
} from '../../../db/repos/chats';
import { getAiAccountType } from '../../../db/repos/project-ai-accounts';
import { createSubChat as createSubChatLocal } from '../../../db/repos/sub-chats';
import { projects as projectsTable } from '../../../db/schema';
import {
  createWorktreeForChat,
  detectBaseBranch,
  getCurrentBranch,
  getDefaultBranch,
  sanitizeProjectName,
} from '../../../git';
import { publicProcedure, router } from '../../index';
import { extractInitialMessageText } from './helpers/message-text';
import { autoNameSubChat, maybeNameBuildProjectFromMessage } from './helpers/name-generation-async';
import { mapLocalChatResponse } from './map-chat-response';
import { mapSubChatResponse } from './sub-chats/map-sub-chat-response';

/** The login the new-chat composer picked; any other credential id is NOT_FOUND. */
async function assertAiAccount(db: ReturnType<typeof getDatabase>, accountId?: string) {
  if (accountId && !(await getAiAccountType(db, accountId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
  }
}

/**
 * Chat creation operations
 *
 * Phase 1 local-first migration: chats and sub-chats are created in local SQLite directly.
 * Worktree git operations remain local; a project lookup hits the local `projects` table
 * (which is hydrated by the projects router on its own schedule).
 */
export const createRouter = router({
  /** Create a new chat with optional git worktree. */
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        projectPath: z.string().optional(),
        name: z.string().optional(),
        taskId: z.string().optional(),
        taskTitle: z.string().optional(),
        initialMessage: z.string().optional(),
        initialMessageParts: z
          .array(
            z.union([
              z.object({ type: z.literal('text'), text: z.string() }),
              z.object({
                type: z.literal('data-image'),
                data: z.object({
                  url: z.string(),
                  mediaType: z.string().optional(),
                  filename: z.string().optional(),
                  base64Data: z.string().optional(),
                }),
              }),
            ]),
          )
          .optional(),
        baseBranch: z.string().optional(),
        branchType: z.enum(['local', 'remote']).optional(),
        useWorktree: z.boolean().default(true),
        existingWorktreePath: z.string().optional(),
        mode: z.enum(['plan', 'agent', 'debug']).default('agent'),
        accountId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const initialMessageText = extractInitialMessageText({
          taskTitle: input.taskTitle,
          initialMessage: input.initialMessage,
          initialMessageParts: input.initialMessageParts,
        });
        // Leave the chat name null until the async helper resolves it. Null
        // is the renderer's cue to show a shimmer; the helper guarantees it
        // ends up non-null (AI > deterministic), then broadcasts
        // `chats:name-updated` so the sidebar and header refresh.
        const seededName = initialMessageText ? null : (input.name ?? null);

        const db = getDatabase();

        // Phase 1 ship-blocker fix (commit a09131): the renderer holds CLOUD project IDs.
        // Local `projects.id` is `createId()`-generated and DOES NOT match cloud ids. A
        // direct `eq(projects.id, input.projectId)` will miss every project until cloud and
        // local are reconciled. Until that reconciliation lands (Phase 2), we fall back to
        // path lookup — the renderer also passes `projectPath`, which IS authoritative
        // locally. Any project the renderer can show is one that's already in local SQLite
        // (added via projects.create / register), so path will resolve.
        let project: { id: string; path: string; name: string } | null = null;

        if (input.projectId && input.projectId.length > 0) {
          // Try by id first (works post-reconciliation or for chats created from a
          // freshly-registered local project).
          const [byId] = await db
            .select()
            .from(projectsTable)
            .where(eq(projectsTable.id, input.projectId))
            .limit(1);
          if (byId) {
            project = { id: byId.id, path: byId.path, name: byId.name };
          } else if (input.projectPath && input.projectPath.length > 0) {
            // Cloud-id miss — fall back to the path the renderer already sent us.
            const [byPath] = await db
              .select()
              .from(projectsTable)
              .where(eq(projectsTable.path, input.projectPath))
              .limit(1);
            if (byPath) {
              project = { id: byPath.id, path: byPath.path, name: byPath.name };
            }
          }

          if (!project) {
            // Deterministic, client-caused miss — a typed NOT_FOUND so the outer catch
            // (which re-throws TRPCError untouched) doesn't relabel it as a 500 or log it
            // as a server fault. Mirrors the in-repo convention (trigger-bindings NOT_FOUND).
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Project not found. ID: ${input.projectId}, Path: ${input.projectPath || 'not provided'}`,
            });
          }
        }

        await assertAiAccount(db, input.accountId);
        const chat = await createChatLocal(db, {
          projectId: project?.id ?? null,
          name: seededName,
          mode: input.mode,
          taskId: input.taskId ?? null,
          accountId: input.accountId,
        });

        // Initial message parts → wrapped as a single user message in the sub-chat's messages array.
        const initialMessages: unknown[] = (() => {
          if (input.initialMessageParts && input.initialMessageParts.length > 0) {
            return [
              {
                id: `msg-${Date.now()}`,
                role: 'user',
                parts: input.initialMessageParts,
              },
            ];
          }
          if (input.initialMessage) {
            return [
              {
                id: `msg-${Date.now()}`,
                role: 'user',
                parts: [{ type: 'text', text: input.initialMessage }],
              },
            ];
          }
          return [];
        })();

        const subChat = await createSubChatLocal(db, {
          chatId: chat.id,
          name: seededName,
          mode: input.mode,
          messages: JSON.stringify(initialMessages),
        });

        // Worktree creation (local git operation). Wrapped in try/catch so a worktree failure
        // doesn't undo the chat — the UI still navigates to the new chat with a fallback path.
        let worktreeResult: {
          worktreePath?: string;
          branch?: string | null;
          baseBranch?: string | null;
        } = {};

        try {
          if (input.useWorktree && project) {
            const result = await createWorktreeForChat(
              project.path,
              sanitizeProjectName(project.name),
              chat.id,
              input.baseBranch,
              input.branchType,
            );

            if (result.success && result.worktreePath) {
              await updateChatLocal(db, chat.id, {
                worktreePath: result.worktreePath,
                branch: result.branch,
                baseBranch: result.baseBranch,
              });
              worktreeResult = {
                worktreePath: result.worktreePath,
                branch: result.branch,
                baseBranch: result.baseBranch,
              };
            } else {
              await updateChatLocal(db, chat.id, { worktreePath: project.path });
              worktreeResult = { worktreePath: project.path };
            }
          } else if (project && input.existingWorktreePath) {
            const ownerChat = await findChatByWorktreeLocal(db, input.existingWorktreePath);
            if (ownerChat && ownerChat.id !== chat.id) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: `This worktree is already used by chat: "${ownerChat.name ?? ownerChat.id}"`,
              });
            }
            let branch: string | null = null;
            let baseBranch: string | null = null;
            try {
              branch = await getCurrentBranch(input.existingWorktreePath);
              if (branch) {
                const defaultBranch = await getDefaultBranch(input.existingWorktreePath);
                baseBranch = await detectBaseBranch(
                  input.existingWorktreePath,
                  branch,
                  defaultBranch,
                );
              }
            } catch {}
            await updateChatLocal(db, chat.id, {
              worktreePath: input.existingWorktreePath,
              branch,
              baseBranch,
            });
            worktreeResult = { worktreePath: input.existingWorktreePath };
          } else if (project) {
            await updateChatLocal(db, chat.id, { worktreePath: project.path });
            worktreeResult = { worktreePath: project.path };
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          // Non-critical: chat exists locally, worktree setup can be retried later.
          log.warn('[Chat Create] Worktree setup failed, chat still created:', err);
          if (project) {
            worktreeResult = { worktreePath: project.path };
            try {
              await updateChatLocal(db, chat.id, { worktreePath: project.path });
            } catch {
              // Even fallback persist failed — chat still usable for this session
            }
          }
        }

        const response = {
          ...mapLocalChatResponse(chat),
          worktreePath: worktreeResult.worktreePath ?? project?.path ?? null,
          branch: worktreeResult.branch ?? chat.branch,
          baseBranch: worktreeResult.baseBranch ?? chat.baseBranch,
          subChats: [mapSubChatResponse(subChat)],
        };

        if (project && input.projectId) {
          trackWorkspaceCreated({
            id: chat.id,
            projectId: input.projectId,
            useWorktree: input.useWorktree,
          });
        }

        if (initialMessageText) {
          void autoNameSubChat({
            chatId: chat.id,
            subChatId: subChat.id,
            projectId: project?.id ?? null,
            projectPath: project?.path ?? null,
            rawUserMessage: initialMessageText,
            isFirstSubChat: true,
          });
          // Separately, name a gitless build project from the goal (abstains on chit-chat). Self-gated.
          void maybeNameBuildProjectFromMessage(project?.id ?? null, initialMessageText);
        }

        return response;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        log.error('[Chat Create] Failed:', message, err);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
      }
    }),
});
