/**
 * start_task block — provisions a git worktree when startInWorktree is on, else completes
 * inline; surfaces projectId/chatId/subChatId/startMode for the agent block.
 */

import { z } from 'zod';
import type { NodeOutput } from '../../../../shared/types/flow';
import { getDatabase } from '../../db';
import { getOrCreateFlowChat } from '../../db/repos/chats';
import { findLatestCompletedRunForNode, getNodeRun } from '../../db/repos/node-runs';
import { captureMainMessage } from '../../sentry/init';
import { buildVariables } from '../block-context';
import { renderTemplate, resolveRoutingTemplate } from '../template-utils';
import { NON_EMPTY_TEXT, resolveDispatchProjectId } from './project-id';
import { executeShellStep } from './shell-step';
import type { Dispatcher } from './types';

/** Graph JSON is unchecked: absent/blank means "no branch"; a non-string is an authoring error. */
const BRANCH_CONFIG = z.union([z.string(), z.undefined(), z.null()]);

type StartTaskConfig = {
  projectId?: string;
  branch?: string;
  startInWorktree?: boolean;
  /** 'plan' gates the downstream agent to non-executing plan mode. */
  startMode?: string;
  /** Per-node model (PICKER id, e.g. `opus-4.8`); inherited by downstream agents when they don't override. */
  model?: string;
  /** Task title field (supports {{…}} templates); names the spawned chat + downstream task. Defaults to 'Flow: Start Task' when empty. */
  label?: string;
};

/** A prior completed run's persisted chat identity — reused by the no-worktree retry path. */
const PRIOR_CHAT_IDENTITY = z.object({
  outputs: z.object({ chatId: NON_EMPTY_TEXT, subChatId: NON_EMPTY_TEXT }),
});

/**
 * Resolves the chat + sub-chat the agent runs in, keyed by worktree path where there is one,
 * else by the prior completed run for this exact (flowRunId, nodeId, lane).
 */
async function resolveChatIdentity(
  ctx: Pick<Parameters<Dispatcher>[0], 'flowRunId' | 'nodeRunId' | 'node'>,
  projectId: string,
  taskTitle: string,
  worktreePath: string | null,
): Promise<{ chatId: string; subChatId: string }> {
  if (worktreePath) {
    return getOrCreateFlowChat(getDatabase(), { projectId, name: taskTitle, worktreePath });
  }
  const currentRun = await getNodeRun(getDatabase(), ctx.nodeRunId);
  const priorRun = await findLatestCompletedRunForNode(getDatabase(), ctx.flowRunId, ctx.node.id, {
    laneIndex: currentRun?.laneIndex ?? null,
    parentFanOutNodeRunId: currentRun?.parentFanOutNodeRunId ?? null,
  });
  const priorIdentity = PRIOR_CHAT_IDENTITY.safeParse(priorRun?.nodeOutput);
  return priorIdentity.success
    ? priorIdentity.data.outputs
    : getOrCreateFlowChat(getDatabase(), { projectId, name: taskTitle, worktreePath });
}

/**
 * The branch to cut a worktree from. Absent means the repo default (the editor removes a cleared field);
 * an authored string must resolve to a real name, so a blank one fails instead of forking from default.
 */
function resolveWorktreeBranch(
  rawConfig: StartTaskConfig['branch'],
  variables: Parameters<typeof resolveRoutingTemplate>[1],
  nodeLabel: string,
): { ok: true; branch: string | undefined } | { ok: false; message: string } {
  const branchConfig = BRANCH_CONFIG.safeParse(rawConfig);
  if (!branchConfig.success) return { ok: false, message: `${nodeLabel}: branch must be text` };
  if (branchConfig.data === undefined || branchConfig.data === null) {
    return { ok: true, branch: undefined };
  }
  const resolved = resolveRoutingTemplate(branchConfig.data, variables);
  return resolved.ok
    ? { ok: true, branch: resolved.value }
    : {
        ok: false,
        message: `${nodeLabel}: branch template "${branchConfig.data}" ${resolved.reason}`,
      };
}

export const dispatchStartTask: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as StartTaskConfig;
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });
  const resolved = await resolveDispatchProjectId(getDatabase(), ctx, variables, 'start_task');
  if (!resolved.ok) return resolved.failure;
  const projectId = resolved.projectId;

  const needsWorktree = config.startInWorktree === true;
  // Branch is read only when a worktree is cut, so an unused branch template cannot fail the node.
  const worktreeBranch = resolveWorktreeBranch(
    needsWorktree ? config.branch : undefined,
    variables,
    `start_task "${ctx.node.label ?? ctx.node.id}"`,
  );
  if (!worktreeBranch.ok) {
    captureMainMessage('Flow start_task refused an unresolvable branch', 'warning', {
      surface: 'flow-start-task',
      reason: 'branch-unresolved',
    });
    return { type: 'error', message: worktreeBranch.message };
  }
  const branch = worktreeBranch.branch;

  const startedAt = Date.now();
  const output: NodeOutput = needsWorktree
    ? await executeShellStep(
        {
          flowRunId: ctx.flowRunId,
          nodeRunId: ctx.nodeRunId,
          blockType: 'start_task',
          projectId,
          branch,
        },
        ctx.signal,
        startedAt,
      )
    : {
        status: 'completed',
        outputs: { worktreePath: '', branch: '', baseBranch: '', configured: true },
        artifacts: [],
        durationMs: 0,
      };
  // Merge conflict in converging-merge start_task surfaces as
  // status='awaiting_input' so the user can resolve it. Don't bury that in
  // a 'completed' DispatchResult — the engine has a dedicated awaiting_input
  // path that pauses the flow run.
  if (output.status === 'awaiting_input') {
    return {
      type: 'awaiting_input',
      reason:
        typeof output.outputs?.error === 'string'
          ? output.outputs.error
          : 'start_task awaiting input (merge conflict)',
    };
  }

  // Create the chat + sub-chat the agent runs in (idempotent per worktree, so a
  // flow retry doesn't leak orphans) and surface projectId/chatId/subChatId +
  // startMode so the downstream agent block can create its task. Without this the
  // agent block errors "previous node outputs no projectId".
  const parsedWorktreePath = NON_EMPTY_TEXT.safeParse(output.outputs?.worktreePath);
  const worktreePath = parsedWorktreePath.success ? parsedWorktreePath.data : null;
  // Task title field (config.label) names the chat — NOT node.label (the step-list display
  // name). Render {{…}} templates and default when empty; mirrors cloud node-dispatch.
  const taskTitle =
    (config.label ? renderTemplate(config.label, variables).trim() : '') || 'Flow: Start Task';
  const { chatId, subChatId } = await resolveChatIdentity(ctx, projectId, taskTitle, worktreePath);

  return {
    type: 'completed',
    output: {
      ...output,
      outputs: {
        ...output.outputs,
        projectId,
        chatId,
        subChatId,
        // Surface the resolved title so the downstream agent block names its task row the
        // same — single source of truth, no chat-name vs task-title drift.
        label: taskTitle,
        ...(config.startMode ? { startMode: config.startMode } : {}),
        ...(config.model ? { model: config.model } : {}),
      },
    },
  };
};
