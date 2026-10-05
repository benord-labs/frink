/** Local executor for one flow step: run_command, start_task and custom nodes. The engine calls
 * `executeFlowStepLocal` via flows/dispatch/shell-step.ts and cancels through its AbortSignal. */

import log from 'electron-log';
import {
  acquireCustomNodeReadLease,
  applyTemplateOptOuts,
  buildCustomNodeInputConfig,
  CUSTOM_NODES_DIR,
  type CustomNodeProcessResult,
  discoverCustomNodes,
  MAX_RAW_FALLBACK_BYTES,
  parseStructuredStdout,
  resolveNodeCredentialEnvVars,
  runCustomNodeProcess,
} from './custom-nodes';
import { getDatabase } from './db';
import { getProjectById as getLocalProjectById } from './db/repos/projects';
import { createWorktreeForBranch } from './git/worktree';
import { createWorktreeWithMergedBases } from './git/worktree-converge';
import { sanitizeProjectName } from './git/worktree-naming';
import { validateWorktreeForReuse } from './git/worktree-validation';
import { runShellCommand, SHELL_TASK_MAX_BUFFER } from './shell-executor';
import { buildSafeEnv } from './terminal/env';

// Output minimization: parse stdout here and carry only structured data onward.
// parseStructuredStdout and its constants live in custom-nodes/parse-node-output.ts.
const MAX_ERROR_MESSAGE_LENGTH = 500; // derived error field (stderr first line + optional spawn detail)
const MAX_OUTPUTS_SERIALIZED_BYTES = 1_048_576; // 1MB cap on total outputs object

type ParsedStepOutput = {
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_input';
  outputs: Record<string, unknown>;
  error?: string;
};

/**
 * Derive a short error message for a step's `error` field.
 * Prefer the first line of stderr; when empty or when spawn/exec detail adds information,
 * include `spawnMessage` (from runShellCommand). Capped at MAX_ERROR_MESSAGE_LENGTH.
 */
function deriveErrorMessage(
  stderr: string,
  exitCode: number | null,
  spawnMessage?: string,
): string {
  const sm = spawnMessage?.trim() ?? '';
  const firstLine = stderr.split('\n')[0]?.trim() ?? '';

  const parts: string[] = [];
  if (firstLine) {
    parts.push(firstLine);
  }
  if (sm && (!firstLine || (sm !== firstLine && !firstLine.includes(sm)))) {
    parts.push(sm);
  }

  const base =
    parts.length > 0 ? parts.join(' — ') : `Command exited with code ${exitCode ?? 'null'}`;

  return base.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** ShellResult → ParsedStepOutput: structured outputs or a truncated _rawStdout, never full
 * stdout/stderr. Structured `status: "awaiting_input"` (a merge conflict) is not a failure. */
function parseNodeOutput(result: ShellResult): ParsedStepOutput {
  if (result.cancelled) return { status: 'cancelled', outputs: {} };
  if (result.timedOut) return { status: 'failed', outputs: {}, error: 'Command timed out' };

  const structured = parseStructuredStdout(result.stdout);
  const baseOutputs: Record<string, unknown> = structured ? { ...structured } : {};

  // Fallback: truncated raw stdout preserves backward compat for templates using outputs._rawStdout
  if (!structured && result.stdout.length > 0) {
    baseOutputs._rawStdout = result.stdout.slice(0, MAX_RAW_FALLBACK_BYTES);
  }

  baseOutputs.exitCode = result.exitCode;

  // Cap total serialized size before carrying the outputs onward
  const serialized = JSON.stringify(baseOutputs);
  const safeOutputs: Record<string, unknown> =
    serialized.length > MAX_OUTPUTS_SERIALIZED_BYTES
      ? {
          _outputsTruncated: true,
          exitCode: result.exitCode,
          _rawStdout: result.stdout.slice(0, MAX_RAW_FALLBACK_BYTES),
        }
      : baseOutputs;

  // start_task converging merge reports awaiting_input via structured stdout (exitCode 0).
  if (result.exitCode === 0 && structured?.status === 'awaiting_input') {
    return { status: 'awaiting_input', outputs: safeOutputs };
  }

  if (result.exitCode === 0) {
    return { status: 'completed', outputs: safeOutputs };
  }

  // exitCode !== 0 (including null = spawn error / process killed without clean exit)

  return {
    status: 'failed',
    outputs: safeOutputs,
    error: deriveErrorMessage(result.stderr, result.exitCode, result.spawnMessage),
  };
}

type FlowExecuteStepPayload = {
  nodeRunId: string;
  flowRunId: string;
  projectId: string;
  blockType: string;
  /** run_command: the shell command to execute */
  command?: string;
  workingDirectory?: 'project_root' | 'trigger_worktree' | 'custom';
  triggerWorktreePath?: string;
  customPath?: string;
  timeoutMs: number;
  /** custom nodes: the block config to pass as JSON argv */
  config?: Record<string, unknown>;
  /** custom nodes: `config` before template rendering, for inputs declared `"template": false` */
  authoredConfig?: FlowExecuteStepPayload['config'];
  /** start_task: branch to checkout in the worktree (when startInWorktree is true) */
  branch?: string;
  /**
   * start_task: converging merge — ordered list of dependency branches (most-recently-completed
   * first, from flows/batch/dependency-branches.ts). When present with 2+ entries, the worktree is
   * created from baseBranches[0] and baseBranches[1..n] are merged in sequentially.
   */
  baseBranches?: string[];
  /** start_task: merge strategy for baseBranches (currently always 'most-recent') */
  mergeStrategy?: string;
  /** start_task: chat row created server-side; merged into step outputs for downstream agent */
  chatId?: string;
  /** start_task: sub_chat row created server-side; merged into step outputs for chat_reply / UI */
  subChatId?: string;
  /** start_task: task row created server-side; merged into step outputs for downstream agent */
  taskId?: string;
};

/**
 * Short-lived project cache to avoid repeated HTTP calls for the same project within a session.
 * TTL of 60s — projects change rarely and any staleness is bounded.
 */
const projectCache = new Map<
  string,
  { project: { id: string; path: string; name: string } | null; expiresAt: number }
>();
const PROJECT_CACHE_TTL_MS = 60_000;

async function getCachedProject(
  projectId: string,
): Promise<{ id: string; path: string; name: string } | null> {
  const cached = projectCache.get(projectId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.project;
  }
  const project = await getLocalProjectById(getDatabase(), projectId).catch(() => null);
  const result = project?.path ? { id: project.id, path: project.path, name: project.name } : null;
  projectCache.set(projectId, { project: result, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  return result;
}

type ShellResult = CustomNodeProcessResult;

/** A step that failed before its process started: no output, no timeout, not cancelled. */
function stepFailure(stderr: string, spawnMessage?: string): ShellResult {
  return {
    stdout: '',
    stderr,
    exitCode: 1,
    timedOut: false,
    cancelled: false,
    ...(spawnMessage !== undefined && { spawnMessage }),
  };
}

const NO_WORKTREE_CAUSE_HINT = `there's no Start Task node upstream in this flow, or the one there has "Start in worktree" unchecked. Add an upstream Start Task with that box ticked, or change this step's working directory.`;

async function resolveCwd(
  payload: FlowExecuteStepPayload,
  projectPath: string,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const wd = payload.workingDirectory ?? 'project_root';

  if (wd === 'trigger_worktree') {
    const worktreePath = payload.triggerWorktreePath;
    if (!worktreePath) {
      return {
        ok: false,
        error: `workingDirectory=trigger_worktree but no triggerWorktreePath provided — ${NO_WORKTREE_CAUSE_HINT}`,
      };
    }
    const validation = await validateWorktreeForReuse(worktreePath);
    if (!validation.valid) {
      return { ok: false, error: `Cannot reuse trigger worktree: ${validation.reason}` };
    }
    return { ok: true, cwd: worktreePath };
  }

  if (wd === 'custom') {
    const cp = typeof payload.customPath === 'string' ? payload.customPath.trim() : '';
    if (!cp) {
      return {
        ok: false,
        error: `workingDirectory=custom but no customPath provided — if this references {{previous.worktreePath}} or another upstream worktree variable, ${NO_WORKTREE_CAUSE_HINT}`,
      };
    }
    return { ok: true, cwd: cp };
  }

  return { ok: true, cwd: projectPath };
}

async function executeRunCommand(
  payload: FlowExecuteStepPayload,
  projectPath: string,
  signal: AbortSignal,
): Promise<ShellResult> {
  const command = payload.command ?? '';
  if (!command.trim()) {
    return { stdout: '', stderr: 'Empty command', exitCode: 1, timedOut: false, cancelled: false };
  }

  const cwdResult = await resolveCwd(payload, projectPath);
  if (!cwdResult.ok) {
    return { stdout: '', stderr: cwdResult.error, exitCode: 1, timedOut: false, cancelled: false };
  }

  const r = await runShellCommand(command, cwdResult.cwd, {
    timeoutMs: payload.timeoutMs,
    maxBuffer: SHELL_TASK_MAX_BUFFER,
    signal,
  });

  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    timedOut: r.timedOut && !signal.aborted,
    cancelled: signal.aborted,
    spawnMessage: r.spawnMessage && r.exitCode === null ? r.spawnMessage : undefined,
  };
}

async function executeCustomNode(
  payload: FlowExecuteStepPayload,
  projectPath: string,
  signal: AbortSignal,
): Promise<ShellResult> {
  const releaseReadLease = await acquireCustomNodeReadLease(payload.blockType, signal);
  if (!releaseReadLease) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      cancelled: true,
      spawnMessage: `Custom node "${payload.blockType}" was cancelled while waiting for an update to finish.`,
    };
  }

  try {
    // discoverCustomNodes(CUSTOM_NODES_DIR) is TTL-cached + invalidated on fs.watch (discovery.ts).
    const { valid } = discoverCustomNodes(CUSTOM_NODES_DIR);
    const manifest = valid.find((m) => m.name === payload.blockType);

    if (!manifest) {
      return stepFailure(`Custom node "${payload.blockType}" not found at ${CUSTOM_NODES_DIR}`);
    }

    // Resolve credentials
    const credResult = resolveNodeCredentialEnvVars(manifest);
    if (!credResult.ok) {
      const missing = credResult.missing.join(', ');
      return stepFailure(
        `Custom node "${payload.blockType}" is missing required credentials: ${missing}`,
      );
    }

    const cwdResult = await resolveCwd(payload, projectPath);
    if (!cwdResult.ok) {
      return stepFailure(cwdResult.error);
    }
    const configValues = buildCustomNodeInputConfig(
      manifest.inputs,
      applyTemplateOptOuts(manifest.inputs, payload.config ?? {}, payload.authoredConfig),
    );
    if (!configValues.ok) {
      return stepFailure('', `Custom node "${payload.blockType}" ${configValues.error}`);
    }
    const configJson = JSON.stringify(configValues.config);
    const timeoutMs = Math.min((manifest.timeout ?? 300) * 1000, 30 * 60 * 1000);
    const env = { ...buildSafeEnv(process.env), ...credResult.envVars };

    try {
      return await runCustomNodeProcess({
        manifest,
        args: [configJson],
        cwd: cwdResult.cwd,
        env,
        timeoutMs,
        maxBuffer: SHELL_TASK_MAX_BUFFER,
        signal,
      });
    } catch (error) {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        cancelled: signal.aborted,
        spawnMessage: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    releaseReadLease();
  }
}

/** Non-empty branch name after trim (avoids treating "", " ", or sole whitespace as valid). */
function isNonEmptyBranchSegment(b: unknown): b is string {
  return typeof b === 'string' && b.trim().length > 0;
}

/**
 * Execute a start_task flow block: provision a git worktree.
 *
 * When payload.baseBranches has 2+ entries (converging CEO-DAG stage), the worktree is created
 * from baseBranches[0] and the remaining branches are merged in sequentially via
 * createWorktreeWithMergedBases. Merge conflicts emit awaiting_input (not failed).
 *
 * Returns a ShellResult whose stdout is JSON-encoded { worktreePath, branch, baseBranch, configured }.
 */
async function executeStartTask(
  payload: FlowExecuteStepPayload,
  projectPath: string,
  projectName: string,
  signal: AbortSignal,
): Promise<ShellResult> {
  if (signal.aborted) {
    return { stdout: '', stderr: 'Cancelled', exitCode: 1, timedOut: false, cancelled: true };
  }

  const sanitizedName = sanitizeProjectName(projectName);

  // Converging merge path: 2+ non-empty branch names (after trim)
  if (
    Array.isArray(payload.baseBranches) &&
    payload.baseBranches.length >= 2 &&
    payload.baseBranches.every(isNonEmptyBranchSegment)
  ) {
    const baseBranches = (payload.baseBranches as string[]).map((s) => s.trim()) as [
      string,
      string,
      ...string[],
    ];
    try {
      const result = await createWorktreeWithMergedBases(projectPath, sanitizedName, baseBranches);

      if (!result.success && !('conflict' in result)) {
        return stepFailure(result.error);
      }

      if (!result.success && 'conflict' in result) {
        // Merge conflict: emit awaiting_input via structured stdout
        const outputs = JSON.stringify({
          status: 'awaiting_input',
          mergeConflict: true,
          conflictingBranch: result.conflictingBranch,
          conflictedFiles: result.conflictedFiles,
          mergedBranches: result.mergedBranches,
          worktreePath: result.worktreePath,
          branch: result.branch,
          baseBranch: result.baseBranch,
          configured: false,
        });
        return { stdout: outputs, stderr: '', exitCode: 0, timedOut: false, cancelled: false };
      }

      // Clean merge: emit completed with all merge details
      const outputs = JSON.stringify({
        worktreePath: result.worktreePath,
        branch: result.branch,
        baseBranch: result.baseBranch,
        mergedBranches: result.mergedBranches,
        configured: true,
      });
      return { stdout: outputs, stderr: '', exitCode: 0, timedOut: false, cancelled: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error in start_task merge';
      return { stdout: '', stderr: message, exitCode: 1, timedOut: false, cancelled: false };
    }
  }

  // Single-branch path: sole non-empty trimmed string, else payload.branch
  const singleBranch =
    Array.isArray(payload.baseBranches) &&
    payload.baseBranches.length === 1 &&
    isNonEmptyBranchSegment(payload.baseBranches[0])
      ? payload.baseBranches[0].trim()
      : payload.branch;

  try {
    const result = await createWorktreeForBranch(projectPath, sanitizedName, singleBranch, signal);
    if (!result.success) {
      return {
        stdout: '',
        stderr: result.error ?? 'Failed to create worktree',
        exitCode: 1,
        timedOut: false,
        cancelled: signal.aborted,
      };
    }
    const outputs = JSON.stringify({
      worktreePath: result.worktreePath,
      branch: result.branch ?? singleBranch,
      baseBranch: result.baseBranch,
      configured: true,
    });
    return { stdout: outputs, stderr: '', exitCode: 0, timedOut: false, cancelled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error in start_task';
    return { stdout: '', stderr: message, exitCode: 1, timedOut: false, cancelled: false };
  }
}

/** The engine's entry point for one step: resolve the project, run the matching executor, parse the
 * result and merge start_task identifiers. Cancel arrives on the supplied AbortSignal. */
export async function executeFlowStepLocal(
  payload: FlowExecuteStepPayload,
  signal: AbortSignal,
): Promise<ParsedStepOutput> {
  const project = await getCachedProject(payload.projectId);
  if (!project) {
    return {
      status: 'failed',
      outputs: {},
      error: `Project ${payload.projectId} not found locally`,
    };
  }

  let result: ShellResult;
  if (payload.blockType === 'start_task') {
    result = await executeStartTask(payload, project.path, project.name, signal);
  } else if (payload.blockType === 'run_command') {
    result = await executeRunCommand(payload, project.path, signal);
  } else {
    result = await executeCustomNode(payload, project.path, signal);
  }

  let parsed = parseNodeOutput(result);
  if (payload.blockType === 'start_task') {
    const merged: Record<string, unknown> = { ...parsed.outputs };
    if (typeof payload.chatId === 'string' && payload.chatId.trim().length > 0) {
      merged.chatId = payload.chatId;
      merged.projectId = payload.projectId;
    }
    if (typeof payload.subChatId === 'string' && payload.subChatId.trim().length > 0) {
      merged.subChatId = payload.subChatId;
    }
    if (typeof payload.taskId === 'string' && payload.taskId.trim().length > 0) {
      merged.taskId = payload.taskId;
    }
    parsed = { ...parsed, outputs: merged };
  }
  return parsed;
}

export type { FlowExecuteStepPayload, ParsedStepOutput };
