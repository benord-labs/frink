import { exec } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import log from 'electron-log';
import { z } from 'zod';
import { resolveCommandShell } from '../platform/command-shell';
import { ensureLoginShellEnv } from '../platform/login-shell-env';

const execAsync = promisify(exec);

// Hand-edited files that don't match read as unreadable instead of crashing readers. Unknown
// keys are kept so a rewrite never deletes content Frink doesn't own.
const WorktreeConfigFileSchema = z.looseObject({
  'setup-worktree': z.array(z.string()).optional(),
  'worktree-base-path': z.string().optional(),
});

export type WorktreeConfig = z.infer<typeof WorktreeConfigFileSchema>;

/** Keys to change; an empty value removes its key. */
export type WorktreeConfigPatch = {
  'setup-worktree'?: string[];
  'worktree-base-path'?: string;
};

export type DetectedWorktreeConfig = {
  config: WorktreeConfig | null;
  path: string | null;
  source: 'frink' | null;
  /** The file exists but isn't a readable config; writing it would destroy its contents. */
  unreadable?: true;
};

const FRINK_CONFIG_PATH = '.frink/worktrees.json';
export const UNREADABLE_CONFIG_MESSAGE = `Frink couldn't read ${FRINK_CONFIG_PATH}. It may have a typo — fix the file, then try again.`;
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Null when the text isn't JSON matching the schema. */
function parseConfigFile(content: string): WorktreeConfig | null {
  try {
    // Windows editors often save UTF-8 with a byte-order mark, which JSON.parse rejects.
    const parsed = WorktreeConfigFileSchema.safeParse(JSON.parse(content.replace(/^\uFEFF/, '')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads a project's `.frink/worktrees.json`. */
export async function detectWorktreeConfig(projectPath: string): Promise<DetectedWorktreeConfig> {
  const frinkPath = join(projectPath, FRINK_CONFIG_PATH);
  // One read, no exists-check first: a file deleted in between must read as missing, not unreadable.
  const content = await readFile(frinkPath, 'utf-8').catch(() => null);
  if (content === null) return { config: null, path: null, source: null };

  const config = parseConfigFile(content);
  return config
    ? { config, path: frinkPath, source: 'frink' }
    : { config: null, path: frinkPath, source: 'frink', unreadable: true };
}

/**
 * Get available config paths for a project
 * Returns which paths exist and can be used
 */
export async function getAvailableConfigPaths(projectPath: string): Promise<{
  frink: { exists: boolean; path: string };
}> {
  const frinkPath = join(projectPath, FRINK_CONFIG_PATH);

  return {
    frink: {
      exists: await fileExists(frinkPath),
      path: frinkPath,
    },
  };
}

/**
 * Merges `patch` into `.frink/worktrees.json` as it is at save time, so keys edited elsewhere
 * since the form loaded survive. Not atomic: a write landing between this read and write is lost.
 *
 * Rejects on write failure — callers must not be able to report success for a write that
 * never landed.
 */
export async function updateWorktreeConfig(
  projectPath: string,
  patch: WorktreeConfigPatch,
): Promise<{ path: string }> {
  const detected = await detectWorktreeConfig(projectPath);
  if (detected.unreadable) throw new Error(UNREADABLE_CONFIG_MESSAGE);

  const next: WorktreeConfig = { ...detected.config, ...patch };
  if (next['setup-worktree']?.length === 0) delete next['setup-worktree'];
  if (next['worktree-base-path'] === '') delete next['worktree-base-path'];

  const targetPath = join(projectPath, FRINK_CONFIG_PATH);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(next, null, 2), 'utf-8');

  return { path: targetPath };
}

export type WorktreeSetupResult = {
  success: boolean;
  commandsRun: number;
  output: string[];
  errors: string[];
};

export type WorktreeSetupOptions = {
  /** Aborts the in-flight command; remaining commands are skipped. */
  signal?: AbortSignal;
  /** Ceiling across ALL commands. Omit for the per-command timeout only. */
  budgetMs?: number;
};

const SETUP_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Budget for a setup run a caller waits on. Deliberately well under the flow engine's
 * block timeout so the local side always decides a step's fate before the server sweep
 * declares it failed and advances the run.
 */
const AWAITED_SETUP_BUDGET_MS = 600_000;

const SETUP_STDERR_TAIL_CHARS = 300;

/** The fields Node's child_process `exec` puts on the error it rejects with. */
const ExecFailureSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stderr: z.string().optional(),
  code: z.union([z.number(), z.string()]).nullish(),
  killed: z.boolean().optional(),
  signal: z.string().nullish(),
});
type ExecFailure = z.infer<typeof ExecFailureSchema>;

function failureStatus(failure: ExecFailure): string {
  if (Number.isInteger(failure.code)) return `exit ${failure.code}`;
  if (failure.name === 'AbortError') return 'cancelled';
  if (failure.killed) return 'timed out';
  return failure.signal ? `signal ${failure.signal}` : '';
}

/** Why a setup command failed, on one line with its own stderr first: callers keep only the start. */
function describeSetupFailure(failure: ExecFailure): string {
  const stderr = stripVTControlCharacters(failure.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
    .slice(-SETUP_STDERR_TAIL_CHARS);
  const status = failureStatus(failure);

  if (stderr) return status ? `${stderr} (${status})` : stderr;
  if (status) return `Command failed (${status})`;
  return failure.message.split('\n')[0];
}

/**
 * Execute worktree setup commands
 * Runs after worktree creation to install deps, copy envs, etc.
 */
export async function executeWorktreeSetup(
  worktreePath: string,
  mainRepoPath: string,
  options: WorktreeSetupOptions = {},
): Promise<WorktreeSetupResult> {
  const result: WorktreeSetupResult = {
    success: true,
    commandsRun: 0,
    output: [],
    errors: [],
  };

  // Detect config from main repo
  const detected = await detectWorktreeConfig(mainRepoPath);
  if (detected.unreadable) {
    // Skipped, not failed: failing would roll back flow worktrees. Settings shows the error.
    log.warn(`[Worktree] ${UNREADABLE_CONFIG_MESSAGE}`);
    result.output.push(UNREADABLE_CONFIG_MESSAGE);
    return result;
  }
  if (!detected.config) {
    result.output.push('No worktree config found, skipping setup');
    return result;
  }

  const commandList = (detected.config['setup-worktree'] ?? []).filter((cmd) => cmd.trim());
  if (commandList.length === 0) {
    result.output.push('No setup commands configured');
    return result;
  }

  const shell = await resolveCommandShell();
  // Setup commands are the user's own tools (bun, pnpm, uv...): make sure process.env carries the
  // login-shell PATH before the first one runs, not the GUI launch PATH.
  await ensureLoginShellEnv();
  const deadline = options.budgetMs === undefined ? null : Date.now() + options.budgetMs;

  for (const cmd of commandList) {
    if (options.signal?.aborted) {
      result.errors.push(`Cancelled before: ${cmd}`);
      break;
    }

    const remainingMs = deadline === null ? SETUP_COMMAND_TIMEOUT_MS : deadline - Date.now();
    if (remainingMs <= 0) {
      result.errors.push(`Setup budget exhausted before: ${cmd}`);
      break;
    }

    try {
      result.output.push(`$ ${cmd}`);

      const { stdout, stderr } = await execAsync(cmd, {
        cwd: worktreePath,
        env: {
          ...process.env,
          ROOT_WORKTREE_PATH: mainRepoPath,
        },
        timeout: Math.min(SETUP_COMMAND_TIMEOUT_MS, remainingMs),
        signal: options.signal,
        ...(shell ? { shell } : {}),
      });

      if (stdout) {
        result.output.push(stdout.trim());
      }
      if (stderr) {
        result.output.push(`[stderr] ${stderr.trim()}`);
      }

      result.commandsRun++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const failure = ExecFailureSchema.safeParse(error);
      const reason = failure.success ? describeSetupFailure(failure.data) : errorMsg;
      result.errors.push(`${reason} — while running: ${cmd}`);
      result.output.push(`[error] ${errorMsg}`);
      // Continue with next command, don't fail entirely
    }
  }

  result.success = result.errors.length === 0;

  return result;
}

/**
 * Run setup and wait for it, bounded and interruptible. Returns an error message when setup did
 * not complete cleanly, or null on success.
 *
 * Callers whose next step runs commands against the dependencies setup installs (flow steps) must
 * use this rather than the background launcher — returning before setup finishes is a race, and a
 * setup failure here is clearer than the downstream command failure it would otherwise cause.
 */
export async function awaitWorktreeSetup(
  worktreePath: string,
  mainRepoPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await executeWorktreeSetup(worktreePath, mainRepoPath, {
    signal,
    budgetMs: AWAITED_SETUP_BUDGET_MS,
  });
  if (result.success) return null;

  log.error('[Worktree] Setup commands failed', { worktreePath, errors: result.errors });
  return `Worktree setup failed: ${result.errors.join('; ')}`;
}

/**
 * Run setup for a freshly created worktree without blocking the caller, logging the outcome.
 * Chat worktrees use this so the user can start typing while dependencies install.
 */
export function startWorktreeSetup(worktreePath: string, mainRepoPath: string): void {
  executeWorktreeSetup(worktreePath, mainRepoPath)
    .then((result) => {
      if (!result.success) {
        log.error('[Worktree] Setup commands failed', { worktreePath, errors: result.errors });
      }
    })
    .catch((error) => {
      log.error('[Worktree] Setup crashed', {
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
