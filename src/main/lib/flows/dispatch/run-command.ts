/**
 * run_command block — render the command template, execute via shared
 * executeShellStep adapter (which calls flow-step-executor.executeRunCommand).
 */

import { getDatabase } from '../../db';
import { resolveUpstreamStartTaskContext } from '../../db/repos/node-runs';
import { resolveCommandShell } from '../../platform/command-shell';
import { captureMainMessage } from '../../sentry/init';
import { buildVariables } from '../block-context';
import { findUpstreamNodeIds } from '../graph';
import {
  findAbsentShellPlaceholder,
  renderTemplateForShell,
  SHELL_RENDER_LIMIT_COMMAND,
} from '../template-utils';
import { resolveDispatchProjectId } from './project-id';
import { executeShellStep } from './shell-step';
import type { DispatchContext, DispatchResult } from './types';

type RunCommandConfig = {
  command?: string;
  projectId?: string;
  workingDirectory?: 'project_root' | 'trigger_worktree' | 'custom';
  customPath?: string;
};

type RunCommandDeps = { resolveCommandShell: typeof resolveCommandShell };

export async function dispatchRunCommand(
  ctx: DispatchContext,
  deps: RunCommandDeps = { resolveCommandShell },
): Promise<DispatchResult> {
  const config = (ctx.node.config ?? {}) as RunCommandConfig;
  const variables = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
  });
  const resolved = await resolveDispatchProjectId(getDatabase(), ctx, variables, 'run_command');
  if (!resolved.ok) return resolved.failure;
  const projectId = resolved.projectId;
  // A command is executable, so a missing value must stop it: rendered empty, `rm -rf /tmp/work/{{x}}`
  // would become `rm -rf /tmp/work/`. Name only the placeholder — the command may hold sensitive text.
  const unresolved = findAbsentShellPlaceholder(config.command ?? '', variables);
  if (unresolved) {
    captureMainMessage('Flow run_command refused an unresolved template placeholder', 'warning', {
      surface: 'flow-run-command',
      reason: 'unresolved-placeholder',
    });
    return {
      type: 'error',
      message: `run_command "${ctx.node.label ?? ctx.node.id}": ${unresolved} did not resolve, so the command was not run`,
    };
  }
  const command = renderTemplateForShell(config.command ?? '', variables);
  // Nothing to run: stop here so the failure names the node instead of surfacing the
  // executor's bare "Empty command".
  if (command.trim() === '') {
    return {
      type: 'error',
      message: `run_command "${ctx.node.label ?? ctx.node.id}": the command is empty, so nothing was run`,
    };
  }
  // Values are escaped for POSIX shells only, so on Windows without Git Bash cmd.exe would read them
  // as syntax. A command the render left unchanged, or swapped for its limit stub, holds no value.
  if (
    command !== (config.command ?? '') &&
    command !== SHELL_RENDER_LIMIT_COMMAND &&
    process.platform === 'win32' &&
    !(await deps.resolveCommandShell())
  ) {
    captureMainMessage('Flow run_command refused Flow values without a POSIX shell', 'warning', {
      surface: 'flow-run-command',
      reason: 'no-posix-shell',
    });
    return {
      type: 'error',
      message: `run_command "${ctx.node.label ?? ctx.node.id}": This command uses Flow values, which need Git Bash on Windows. Install Git for Windows, then run it again.`,
    };
  }

  // Resolve the worktree from the flow's upstream start_task (not the immediate
  // predecessor — a condition/agent in between drops worktreePath; sc-802). Only
  // needed for workingDirectory === 'trigger_worktree'; otherwise the executor
  // ignores it. Without this the executor throws 'no triggerWorktreePath provided'.
  const triggerWorktreePath =
    config.workingDirectory === 'trigger_worktree'
      ? (
          await resolveUpstreamStartTaskContext(getDatabase(), ctx.flowRunId, {
            nodeRunId: ctx.nodeRunId,
            upstreamNodeIds: findUpstreamNodeIds(ctx.parsedGraph, ctx.node.id),
          })
        )?.worktreePath
      : undefined;

  const startedAt = Date.now();
  const output = await executeShellStep(
    {
      flowRunId: ctx.flowRunId,
      nodeRunId: ctx.nodeRunId,
      blockType: 'run_command',
      projectId,
      command,
      workingDirectory: config.workingDirectory,
      customPath: config.customPath,
      triggerWorktreePath,
    },
    ctx.signal,
    startedAt,
  );
  return { type: 'completed', output };
}
