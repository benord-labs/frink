/* eslint-disable max-lines, max-lines-per-function */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { z } from 'zod';
import { trackMessageSent, trackWorkspaceCreated } from '../../../analytics';
import { rehomePastedMentions } from '../../../claude/pasted-files';
import { isValidSubChatIdForSessionPaths } from '../../../claude/session-plan-paths';
import { getDatabase } from '../../../db';
import {
  createChat as createChatLocal,
  findChatByWorktree as findChatByWorktreeLocal,
  updateChat as updateChatLocal,
} from '../../../db/repos/chats';
import { getAiAccountType } from '../../../db/repos/project-ai-accounts';
import {
  createSubChat as createSubChatLocal,
  getSubChatById,
  type SubChatHydrated,
  updateSubChatMessages,
} from '../../../db/repos/sub-chats';
import { projects as projectsTable } from '../../../db/schema';
import { createId, isPrimaryKeyConflict } from '../../../db/utils';
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

/** A worktree another chat already uses is refused before anything is inserted. */
async function assertWorktreeFree(db: ReturnType<typeof getDatabase>, worktreePath: string) {
  const owner = await findChatByWorktreeLocal(db, worktreePath);
  if (owner) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `This worktree is already used by chat: "${owner.name ?? owner.id}"`,
    });
  }
}

/** The first sub-chat's id: the composer's own (its pastes already sit in that folder) when usable,
 *  else a fresh one, which `rehomeParts` copies those pastes under. */
async function claimSubChatId(db: ReturnType<typeof getDatabase>, subChatId?: string) {
  if (!subChatId) return undefined;
  if (isValidSubChatIdForSessionPaths(subChatId) && !(await getSubChatById(db, subChatId))) {
    return subChatId;
  }
  log.warn('[chats.create] composer sub-chat id is unsafe or taken; minting a fresh one');
  return createId();
}

type TextPart = { type: string; text?: string };

/** Points the first message's pastes at the claimed id's folder, wherever they were saved: a
 *  replaced composer id, or a draft restored after its old id was claimed by an earlier send. */
async function rehomeParts<T extends TextPart>(parts: T[], to: string): Promise<T[]> {
  return Promise.all(
    parts.map(async (part) =>
      part.type === 'text' && part.text !== undefined
        ? { ...part, text: await rehomePastedMentions(part.text, to) }
        : part,
    ),
  );
}

/** The first message as the sub-chat's transcript: the composer's parts, else its plain text. */
function toInitialMessages(parts: unknown[] | undefined, text: string | undefined): unknown[] {
  let body: unknown[] | null = null;
  if (parts && parts.length > 0) body = parts;
  else if (text) body = [{ type: 'text', text }];
  return body ? [{ id: `msg-${Date.now()}`, role: 'user', parts: body }] : [];
}

type FirstSubChat = Parameters<typeof createSubChatLocal>[1];

/** Inserts the first sub-chat. An id taken by the time of the insert (a create racing this one) is
 *  retried once under a fresh id instead of failing the whole create. */
async function insertFirstSubChat(db: ReturnType<typeof getDatabase>, subChat: FirstSubChat) {
  try {
    return await createSubChatLocal(db, subChat);
  } catch (err) {
    if (!subChat.id || !(err instanceof Error) || !isPrimaryKeyConflict(err)) throw err;
    log.warn('[chats.create] composer sub-chat id was taken at insert; retrying with a fresh one');
    return createSubChatLocal(db, { ...subChat, id: createId() });
  }
}

/** Copies the first message's pastes into the sub-chat's folder only once the insert has made its
 *  id ours, so a racing create never gets copies in its folder, then stores the repointed text.
 *  Failing here keeps the old paths, like a single file that cannot be copied: the chat exists. */
async function rehomeFirstMessage<T extends TextPart>(
  db: ReturnType<typeof getDatabase>,
  subChat: SubChatHydrated,
  parts: T[],
): Promise<SubChatHydrated> {
  try {
    const rehomed = await rehomeParts(parts, subChat.id);
    if (rehomed.every((part, i) => part.text === parts[i]?.text)) return subChat;
    const updated = await updateSubChatMessages(db, subChat.id, ([first, ...rest]) =>
      first ? [{ ...first, parts: rehomed }, ...rest] : null,
    );
    return updated ?? subChat;
  } catch (err) {
    log.warn('[chats.create] first message pastes not moved; they keep their old paths', err);
    return subChat;
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
        /** Id for the first sub-chat, minted by the composer so its pastes land in its folder. */
        subChatId: z.string().optional(),
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
        const subChatId = await claimSubChatId(db, input.subChatId);

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
        if (project && !input.useWorktree && input.existingWorktreePath) {
          await assertWorktreeFree(db, input.existingWorktreePath);
        }
        const chat = await createChatLocal(db, {
          projectId: project?.id ?? null,
          name: seededName,
          mode: input.mode,
          taskId: input.taskId ?? null,
          accountId: input.accountId,
        });

        // Initial message parts → wrapped as a single user message in the sub-chat's messages array.
        const inserted = await insertFirstSubChat(db, {
          chatId: chat.id,
          name: seededName,
          mode: input.mode,
          messages: JSON.stringify(
            toInitialMessages(input.initialMessageParts, input.initialMessage),
          ),
          ...(subChatId && { id: subChatId }),
        });
        const subChat =
          input.subChatId && input.initialMessageParts
            ? await rehomeFirstMessage(db, inserted, input.initialMessageParts)
            : inserted;

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

        if (input.initialMessageParts?.length || input.initialMessage) {
          trackMessageSent({
            workspaceId: subChat.id,
            messageLength:
              extractInitialMessageText({ ...input, taskTitle: undefined })?.length ?? 0,
            mode: input.mode,
            startsChat: true,
          });
        }
        if (initialMessageText) {
          void autoNameSubChat({
            chatId: chat.id,
            subChatId: subChat.id,
            projectId: project?.id ?? null,
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
