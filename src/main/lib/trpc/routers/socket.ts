/**
 * Socket Router
 * tRPC procedures for chat dispatch.
 */

import { z } from 'zod';
import { approvedPlanContextSchema } from '../../../../shared/types/approved-plan-context-schema';
import { CODEX_SPEEDS } from '../../../../shared/types/execution';
import {
  listPendingQuestionProjections,
  listPendingQuestionSubChatIds,
} from '../../claude/ask-user-question-approval';
import { captureMainException } from '../../sentry/init';
import { sendMessage, sendStop } from '../../socket';
import { readCommandOutput } from '../../socket/command-output';
import { prewarmClaudeSession } from '../../socket/execution/claude-session/prewarm';
import { stopBackgroundTask } from '../../socket/execution/claude-session/stop-background-task';
import { listWakeHolds } from '../../socket/execution/wake-hold-registry-view';
import { steerActiveTurn } from '../../socket/steering';
import { getLiveStreamSeed, listLiveStreamHeaders } from '../../socket/streaming/live-stream';
import {
  listBackgroundRosters,
  listRunningSubagentTasks,
  readWorkflowProgress,
} from '../../socket/streaming/subagent-task-status';
import {
  listPendingMoveChatRequests,
  listPendingPermissionRequests,
} from '../../socket/streaming/pending-permission';
import { publicProcedure, router } from '../index';

// Zod schema for message parts
const messagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    mimeType: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough();

// Zod schema for messages
const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(messagePartSchema),
  metadata: z
    .object({
      sessionId: z.string().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      totalCostUsd: z.number().optional(),
      durationMs: z.number().optional(),
      resultSubtype: z.string().optional(),
      finalTextId: z.string().optional(),
      // Display-only provenance for an answered-question card. Listed explicitly because this
      // object — unlike `messagePartSchema` above — is strict, so an unlisted key is dropped in
      // silence: that is how a picked answer reached the database as `{}`.
      answeredQuestions: z.array(z.object({ label: z.string(), answer: z.string() })).optional(),
    })
    .optional(),
});

const chatModeSchema = z.enum(['agent', 'plan', 'debug']);

const executionSettingsSchema = z.object({
  maxThinkingTokens: z.number().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  model: z.string().optional(), // Claude: haiku|sonnet|opus; Codex: gpt-5.1-codex|etc
  enableTasks: z.boolean().optional(),
  betas: z.array(z.string().max(64)).max(5).optional(),
  // Provider-native Auto reviewer; unsupported runtimes ignore it.
  autoReviewTools: z.boolean().optional(),
  // Codex speed; `fast` requests the priority service tier, billed at a credit multiplier.
  codexSpeed: z.enum(CODEX_SPEEDS).optional(),
  // Claude Ultra tier: CLI session `ultracode` (parallel-agent orchestration).
  ultra: z.boolean().optional(),
});

export const socketRouter = router({
  /**
   * Every sub-chat currently held open waiting on background work.
   *
   * A PULL, because hold state reaches the renderer only as a push event and is kept purely in
   * memory: a window that reloads mid-wait loses the held row and its Stop while the main process
   * keeps pumping. A main-side replay cannot fix that — it would fire before the renderer's
   * listener mounts — so the booting window asks instead.
   */
  listWakeHolds: publicProcedure.query(() => listWakeHolds()),

  /** Same pull-on-boot seam for subagent cards: a reload would otherwise read a running background
   * subagent as "Completed Subagent" until its task ends. */
  listRunningSubagentTasks: publicProcedure.query(() => listRunningSubagentTasks()),

  /** And for the background-work row's live roster, which is pushed only on a membership change. */
  listBackgroundRosters: publicProcedure.query(() => listBackgroundRosters()),

  /** Listener-first renderer boot uses these bounded projections to reattach to main-owned runs. */
  listLiveStreamHeaders: publicProcedure.query(() => listLiveStreamHeaders()),

  listPendingQuestionSubChatIds: publicProcedure.query(() => listPendingQuestionSubChatIds()),

  /** A held Workflow's phases and agents, pulled only while the user has the list open. */
  getWorkflowProgress: publicProcedure
    .input(z.object({ subChatId: z.string().min(1), taskId: z.string().min(1) }))
    .query(({ input }) => readWorkflowProgress(input.subChatId, input.taskId)),

  /** A running command's latest output, pulled every second only while the user watches it. */
  getCommandOutput: publicProcedure
    .input(z.object({ subChatId: z.string().min(1), commandId: z.string().min(1) }))
    .query(({ input }) => readCommandOutput(input.subChatId, input.commandId)),

  listPendingPermissionRequests: publicProcedure.query(() => [
    ...listPendingPermissionRequests(),
    ...listPendingMoveChatRequests(),
  ]),

  getLiveStreamSeed: publicProcedure
    .input(z.object({ subChatId: z.string().min(1) }))
    .query(({ input }) => ({
      ...getLiveStreamSeed(input.subChatId),
      pendingQuestions: listPendingQuestionProjections(input.subChatId),
    })),

  /**
   * Send message via WebSocket
   * Server handles persistence and routes to executor
   */
  sendMessage: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        projectId: z.string(),
        trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
        userMessage: messageSchema,
        // Optional transition intent; absent → sendMessage resolves from the sub-chat row
        // (decision `sub-chat-mode-ownership`).
        mode: chatModeSchema.optional(),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            }),
          )
          .optional(),
        settings: executionSettingsSchema.optional(),
        approvedPlanContext: approvedPlanContextSchema.optional(),
        navigationSessionId: z.string().optional(),
        expectedFlowTaskId: z.string().min(1).optional(),
        // Machine-dispatch identity: binds the turn's mode to the dispatching task in main
        // (dispatch-registry; decision `sub-chat-mode-ownership`, machine-turn amendment).
        dispatchTaskId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await sendMessage({
          ...input,
          ...(Number.isInteger(ctx.senderWebContentsId)
            ? { sourceWebContentsId: ctx.senderWebContentsId }
            : {}),
        });
        return { success: true as const };
      } catch (error) {
        return {
          success: false as const,
          reason: error instanceof Error ? error.message : 'Failed to send message',
          category: (error as { category?: string } | null)?.category,
        };
      }
    }),

  /**
   * Steer the turn this sub-chat is ALREADY running: the message is handed to the live agent and
   * spliced in at its next model invocation, so the in-flight tool call still completes.
   *
   * Deliberately NOT routed through `sendMessage`: that path reaches `handleRemoteExecute`, whose
   * duplicate-request guard aborts the running execution — the exact destruction steering avoids.
   * An outcome other than `delivered` means the caller must QUEUE the message; it must never retry
   * as a direct send.
   */
  steerMessage: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        text: z.string().min(1),
        imageParts: z.array(z.object({ mediaType: z.string(), base64Data: z.string() })).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const outcome = await steerActiveTurn(input.subChatId, {
          text: input.text,
          ...(input.imageParts ? { imageParts: input.imageParts } : {}),
        });
        return { success: true as const, outcome };
      } catch (error) {
        // A steer that throws must read as "not delivered" so the caller queues rather than
        // silently dropping the user's message — but the queue fallback is invisible to the user as
        // a FAULT, so the underlying failure is captured rather than only surfaced as a toast.
        captureMainException(error, { surface: 'steer', stage: 'deliver' });
        return {
          success: false as const,
          reason: error instanceof Error ? error.message : 'Failed to steer',
        };
      }
    }),

  /** Start the chat's Claude CLI ahead of its send, from what that send would carry. */
  prewarmClaudeSession: publicProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        subChatId: z.string().min(1),
        mode: chatModeSchema.optional(),
        settings: executionSettingsSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => ({ outcome: await prewarmClaudeSession(input) })),

  /**
   * Send stop signal to remote machine
   */
  sendStop: publicProcedure
    .input(z.object({ chatId: z.string(), subChatId: z.string() }))
    .mutation(({ input }) => {
      try {
        sendStop(input);
        return { success: true as const };
      } catch (error) {
        return {
          success: false as const,
          reason: error instanceof Error ? error.message : 'Failed to send stop signal',
        };
      }
    }),

  /** Stop ONE background task of a held chat; the rest of its wait keeps running. */
  stopBackgroundTask: publicProcedure
    .input(z.object({ subChatId: z.string().min(1), taskId: z.string().min(1) }))
    .mutation(({ input }) => stopBackgroundTask(input.subChatId, input.taskId)),
});
