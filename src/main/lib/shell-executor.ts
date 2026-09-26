/**
 * Direct shell execution for flow `run_command` tasks (executionMode: shell).
 * Captures stdout/stderr/exitCode for signal-bridge → NodeOutput.outputs (incl. JSON parse).
 */

import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import { extractRawTriggerConfig } from '../../shared/lib/trigger-rule-config';
import { taskResultSchema } from '../../shared/types/task-result';
import { resolveNodeCredentialEnvVars } from './custom-nodes/credentials';
import { CUSTOM_NODES_DIR, discoverCustomNodes } from './custom-nodes/discovery';
import { getDatabase } from './db';
import { getProjectById as getLocalProjectById } from './db/repos/projects';
import { parseResultRecord, updateTaskStatus as updateTaskStatusLocal } from './db/repos/tasks';
import type { Task as DbTask } from './db/schema';
import { validateWorktreeForReuse } from './git/worktree-validation';
import { resolveCommandShell } from './platform/command-shell';

export const SHELL_TASK_TIMEOUT_MS = 5 * 60 * 1000;
/** Single maxBuffer for exec (stdout/stderr); matches signal-bridge parse cap for stdout. */
export const SHELL_TASK_MAX_BUFFER = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function extractShellTaskTriggerConfig(triggerContext: DbTask['triggerContext']) {
  const parsed = taskResultSchema.safeParse(triggerContext);
  return extractRawTriggerConfig(parsed.success ? parsed.data : undefined);
}

type ResolveShellCwdResult = { ok: true; cwd: string } | { ok: false; error: string };

/**
 * Resolves working directory for a shell task from trigger_context._config.executionOverride
 * and project root. Exported for unit tests.
 */
export async function resolveShellTaskCwd(
  task: DbTask,
  projectPath: string | null,
): Promise<ResolveShellCwdResult> {
  const rawConfig = extractShellTaskTriggerConfig(task.triggerContext);
  const override =
    rawConfig !== undefined && isRecord(rawConfig.executionOverride)
      ? (rawConfig.executionOverride as Record<string, unknown>)
      : null;

  if (override?.reuseWorktree === true) {
    const worktreePath = typeof override.worktreePath === 'string' ? override.worktreePath : null;
    if (!worktreePath) {
      return { ok: false, error: 'reuseWorktree requested but no worktreePath provided' };
    }
    const validation = await validateWorktreeForReuse(worktreePath);
    if (!validation.valid) {
      return {
        ok: false,
        error: `Cannot reuse trigger worktree: ${validation.reason}`,
      };
    }
    return { ok: true, cwd: worktreePath };
  }

  if (typeof override?.customPath === 'string' && override.customPath.trim() !== '') {
    return { ok: true, cwd: override.customPath.trim() };
  }

  if (!projectPath || projectPath.trim() === '') {
    return { ok: false, error: 'No project path resolved for shell task' };
  }
  return { ok: true, cwd: projectPath };
}

type ShellCommandOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnMessage?: string;
};

/**
 * Runs a shell command with timeout and buffer limits. Exported for tests (mock at module boundary).
 *
 * When `options.signal` is provided, the process is killed if the signal is aborted.
 * The caller can distinguish abort-kills from timeout-kills by checking `signal.aborted`
 * after the promise resolves (both produce `timedOut: true` from exec, but aborted=true means cancel).
 */
export async function runShellCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; maxBuffer: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ShellCommandOutcome> {
  const shell = await resolveCommandShell();
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(shell ? { shell } : {}),
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (!error) {
          resolve({ stdout: out, stderr: errOut, exitCode: 0, timedOut: false });
          return;
        }
        const errCode = (error as { code?: string | number }).code;
        if (error.killed && error.signal === 'SIGTERM') {
          const maxBufferExceeded =
            errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
            (typeof error.message === 'string' && error.message.includes('maxBuffer'));
          resolve({
            stdout: out,
            stderr: errOut,
            exitCode: null,
            timedOut: !maxBufferExceeded,
            spawnMessage: maxBufferExceeded ? 'Output exceeded 1MB buffer limit' : undefined,
          });
          return;
        }
        if (typeof errCode === 'number' && Number.isFinite(errCode)) {
          resolve({ stdout: out, stderr: errOut, exitCode: errCode, timedOut: false });
          return;
        }
        resolve({
          stdout: out,
          stderr: errOut,
          exitCode: null,
          timedOut: false,
          spawnMessage: error.message,
        });
      },
    );

    // Cancellation support: kill the child process when the AbortSignal fires.
    if (options.signal) {
      const onAbort = () => child.kill('SIGTERM');
      if (options.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        child.once('close', () => options.signal?.removeEventListener('abort', onAbort));
      }
    }
  });
}

export function isShellExecutionMode(triggerContext: DbTask['triggerContext']): boolean {
  const raw = extractShellTaskTriggerConfig(triggerContext);
  return raw?.executionMode === 'shell';
}

/**
 * Reads the blockType for custom nodes from trigger_context._config.
 * Returns null for non-custom-node shell tasks (e.g. run_command).
 */
function resolveCustomNodeBlockType(triggerContext: DbTask['triggerContext']): string | null {
  const raw = extractShellTaskTriggerConfig(triggerContext);
  const blockType = raw?.blockType;
  if (typeof blockType !== 'string') return null;
  // run_command is a built-in block type, not a custom node
  if (blockType === 'run_command') return null;
  return blockType;
}

/**
 * Resolves credential env vars for a custom node task.
 * Returns {} if the task is not a custom node or no credentials are declared.
 * Returns null and logs an error if a required credential is missing (caller should fail the task).
 */
async function resolveCustomNodeCredentialEnvVars(
  triggerContext: DbTask['triggerContext'],
): Promise<{ ok: true; envVars: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  const blockType = resolveCustomNodeBlockType(triggerContext);
  if (!blockType) return { ok: true, envVars: {} };

  const { valid } = discoverCustomNodes(CUSTOM_NODES_DIR);
  const manifest = valid.find((m) => m.name === blockType);

  if (!manifest) {
    // Node not installed locally — no credentials to inject, not an error
    log.warn(
      `[shell-executor] custom node "${blockType}" not found locally — no credentials injected`,
    );
    return { ok: true, envVars: {} };
  }

  if (Object.keys(manifest.credentials).length === 0) {
    return { ok: true, envVars: {} };
  }

  const result = resolveNodeCredentialEnvVars(manifest);
  if (!result.ok) {
    const missing = result.missing.join(', ');
    return {
      ok: false,
      error: `Custom node "${blockType}" is missing required credentials: ${missing}. Configure them in the node's config panel.`,
    };
  }

  return { ok: true, envVars: result.envVars };
}

/** Reads custom node timeout from trigger context _config (seconds → ms), with safe fallback. */
export function resolveShellTaskTimeoutMs(triggerContext: DbTask['triggerContext']): number {
  const raw = extractShellTaskTriggerConfig(triggerContext);
  const seconds = typeof raw?.customNodeTimeout === 'number' ? raw.customNodeTimeout : null;
  if (seconds !== null && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 30 * 60 * 1000); // cap at 30 minutes
  }
  return SHELL_TASK_TIMEOUT_MS;
}

/**
 * Runs a flow-linked shell task and PATCHes terminal status + result for signal-bridge.
 */
export async function executeShellTask(task: DbTask): Promise<void> {
  if (!isShellExecutionMode(task.triggerContext)) {
    throw new Error('executeShellTask called without executionMode shell');
  }

  const command = task.description?.trim() ?? '';
  if (!command) {
    log.warn('[TaskExecutor] shell task rejected: empty command', { taskId: task.id });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
      result: { error: 'Empty command', exitCode: null },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
    return;
  }

  if (!task.projectId) {
    log.warn('[TaskExecutor] shell task rejected: missing project_id', { taskId: task.id });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
      result: { error: 'Shell task missing project_id', exitCode: null },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
    return;
  }

  let cwd: string;
  try {
    const cloudProject = await getLocalProjectById(getDatabase(), task.projectId);
    const projectPath = cloudProject?.path ?? null;
    const resolved = await resolveShellTaskCwd(task, projectPath);
    if (!resolved.ok) {
      log.warn('[TaskExecutor] shell task cwd resolution failed', {
        taskId: task.id,
        error: resolved.error,
      });
      await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
        result: { error: resolved.error, exitCode: null },
        ...(task.executedBy ? { executedBy: task.executedBy } : {}),
      });
      return;
    }
    cwd = resolved.cwd;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve working directory';
    log.error('[TaskExecutor] shell task cwd resolution threw', {
      taskId: task.id,
      error: message,
    });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
      result: { error: message, exitCode: null },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
    return;
  }

  // Resolve credential env vars for custom nodes before taking the execution lease
  const credResult = await resolveCustomNodeCredentialEnvVars(task.triggerContext);
  if (!credResult.ok) {
    log.warn('[TaskExecutor] shell task rejected: missing credentials', {
      taskId: task.id,
      error: credResult.error,
    });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
      result: { error: credResult.error, exitCode: null },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
    return;
  }

  const credEnv = credResult.envVars;
  const taskEnv = Object.keys(credEnv).length > 0 ? { ...process.env, ...credEnv } : undefined;

  const executionLeaseId = randomUUID();
  const prevResult = parseResultRecord(task.result);

  try {
    await updateTaskStatusLocal(getDatabase(), task.id, 'running', {
      result: { ...prevResult, executionLeaseId, shellExecution: true },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });

    log.info('[TaskExecutor] shell task executing', {
      taskId: task.id,
      cwd,
      commandPreview: command.slice(0, 120),
    });

    const r = await runShellCommand(command, cwd, {
      timeoutMs: resolveShellTaskTimeoutMs(task.triggerContext),
      maxBuffer: SHELL_TASK_MAX_BUFFER,
      env: taskEnv,
    });

    const result: Record<string, unknown> = {
      stdout: r.stdout,
      stderr: r.stderr,
    };
    if (r.timedOut) {
      result.error = 'Command timed out';
      result.exitCode = null;
    } else if (r.spawnMessage && r.exitCode === null) {
      result.error = r.spawnMessage;
      result.exitCode = null;
    } else if (r.exitCode !== null) {
      result.exitCode = r.exitCode;
    }

    const terminalStatus = !r.timedOut && r.exitCode === 0 ? 'completed' : 'failed';
    log.info('[TaskExecutor] shell task finished', {
      taskId: task.id,
      terminalStatus,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    });
    await updateTaskStatusLocal(getDatabase(), task.id, terminalStatus, {
      result,
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Shell execution failed';
    log.error('[TaskExecutor] shell task execution error', { taskId: task.id, error: message });
    await updateTaskStatusLocal(getDatabase(), task.id, 'failed', {
      result: { error: message, exitCode: null },
      ...(task.executedBy ? { executedBy: task.executedBy } : {}),
    });
  }
}
