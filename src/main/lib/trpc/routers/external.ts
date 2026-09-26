import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shell } from 'electron';
import { z } from 'zod';
import { expandHomePath as expandTilde } from '../../../../shared/lib/expand-home';
import { publicProcedure, router } from '../index';

/**
 * macOS editor apps probed by display name via `open -a`. LaunchServices
 * resolves the name regardless of the app's (often opaque) bundle id,
 * forwards to a running instance, and exits 0 only when the app was found —
 * the exit code is what makes the fallback chain reliable.
 */
const MAC_EDITOR_APPS = ['Cursor', 'Visual Studio Code', 'Visual Studio Code - Insiders'] as const;

export type TerminalOpenResult = { success: true } | { success: false; error: string };

export type EditorOpenResult =
  | { success: true; editor: string }
  | { success: false; error: string };

type DetachedSpawnOptions = {
  cwd?: string;
};

function spawnDetached(
  command: string,
  args: string[],
  options: DetachedSpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        cwd: options.cwd,
      });
      child.once('error', onError);
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        if (typeof child.off === 'function') {
          child.off('error', onError);
        } else if (typeof child.removeListener === 'function') {
          child.removeListener('error', onError);
        }
        child.unref();
        resolve();
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

/**
 * Spawn a command and resolve its numeric exit code (rejecting only if the
 * binary itself can't be launched). Unlike `spawnDetached`, this awaits the
 * process so callers can branch on success — `open -a <app>` exits non-zero
 * when the app isn't installed, which drives the editor fallback chain.
 */
function spawnForExitCode(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.once('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        resolve(code ?? 1);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

/** Run `open <args>` and report whether it exited cleanly (0). A launch error
 * (`open` missing) counts as "did not open" so callers fall through. */
async function openExitedClean(args: string[]): Promise<boolean> {
  try {
    return (await spawnForExitCode('open', args)) === 0;
  } catch {
    return false;
  }
}

/** Probe the known macOS editors then the default text editor, returning the
 * editor label that opened the file, or null when none did. */
async function openWithMacEditor(absPath: string): Promise<string | null> {
  for (const app of MAC_EDITOR_APPS) {
    if (await openExitedClean(['-a', app, absPath])) return app;
  }
  return (await openExitedClean(['-t', absPath])) ? 'default-text' : null;
}

/**
 * Open a file in the user's external editor. Resolves relative paths against
 * `cwd` first (an absolute path is required so `open` targets the right file).
 * macOS probes editors by exit code, then falls back to the default text
 * editor and finally the system handler; other platforms use the handler.
 */
export async function openFileInEditor(
  filePath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<EditorOpenResult> {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd || process.cwd(), filePath);

  if (platform === 'darwin') {
    const editor = await openWithMacEditor(absPath);
    if (editor) return { success: true, editor };
  }

  const openError = await shell.openPath(absPath);
  if (openError) {
    return { success: false, error: openError };
  }
  return { success: true, editor: 'default' };
}

export async function openInTerminal(
  workingDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TerminalOpenResult> {
  try {
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
  } catch {
    return { success: false, error: 'Directory does not exist' };
  }

  if (platform === 'darwin') {
    const macCommands: Array<{ command: string; args: string[] }> = [
      { command: 'open', args: ['-a', 'Terminal', workingDirectory] },
      { command: 'open', args: ['-a', 'iTerm', workingDirectory] },
    ];

    for (const cmd of macCommands) {
      try {
        await spawnDetached(cmd.command, cmd.args);
        return { success: true };
      } catch {
        // Try next candidate
      }
    }

    return { success: false, error: 'Unable to open an external terminal app on macOS' };
  }

  if (platform === 'win32') {
    const windowsCommands: Array<{ command: string; args: string[]; cwd?: string }> = [
      { command: 'wt.exe', args: ['-d', workingDirectory] },
      {
        command: 'cmd.exe',
        // Use cwd option to avoid embedding an unescaped path in command text.
        args: ['/c', 'start', '', 'cmd.exe', '/K'],
        cwd: workingDirectory,
      },
    ];

    for (const cmd of windowsCommands) {
      try {
        await spawnDetached(cmd.command, cmd.args, { cwd: cmd.cwd });
        return { success: true };
      } catch {
        // Try next candidate
      }
    }

    return { success: false, error: 'Unable to open an external terminal app on Windows' };
  }

  const linuxCommands: Array<{ command: string; args: string[] }> = [
    { command: 'x-terminal-emulator', args: ['--working-directory', workingDirectory] },
    { command: 'gnome-terminal', args: ['--working-directory', workingDirectory] },
    { command: 'konsole', args: ['--workdir', workingDirectory] },
  ];

  for (const cmd of linuxCommands) {
    try {
      await spawnDetached(cmd.command, cmd.args);
      return { success: true };
    } catch {
      // Try next candidate
    }
  }

  return { success: false, error: 'Unable to open an external terminal app on this platform' };
}

/**
 * External router for shell operations (open in finder, open in editor, etc.)
 */
export const externalRouter = router({
  openInFinder: publicProcedure.input(z.string()).mutation(async ({ input: inputPath }) => {
    const expandedPath = expandTilde(inputPath);
    shell.showItemInFolder(expandedPath);
    return { success: true };
  }),

  openFileInEditor: publicProcedure
    .input(
      z.object({
        path: z.string(),
        cwd: z.string().optional(),
      }),
    )
    .mutation(({ input }) => openFileInEditor(input.path, input.cwd)),

  openExternal: publicProcedure.input(z.string()).mutation(async ({ input: url }) => {
    const { shellOpenExternalGuarded } = await import('../../open-external-guarded');
    return shellOpenExternalGuarded(url);
  }),

  openInTerminal: publicProcedure.input(z.string()).mutation(async ({ input: inputPath }) => {
    const expandedPath = expandTilde(inputPath);
    return openInTerminal(expandedPath);
  }),

  /**
   * Get the user's home directory path
   * Used as fallback cwd for general chats without a project
   */
  getHomePath: publicProcedure.query(() => {
    return os.homedir();
  }),
});
