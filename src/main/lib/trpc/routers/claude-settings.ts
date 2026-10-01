import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
  claudeVersionSupportsUltra,
  claudeVersionSupportsXhigh,
  getBundledClaudeVersion,
} from '../../claude';
import {
  DEFAULT_WORKTREE_BASE_PATH,
  FRINK_WORKTREE_CONFIG_PATH,
  resetWorktreeBasePath,
  resolveWorktreeBasePath,
  setWorktreeBasePath,
} from '../../worktree/base-path-config';
import {
  isAbsoluteWorktreeBasePathInput,
  isSensitiveWorktreeBasePath,
  normalizeWorktreeBasePath,
} from '../../worktree/base-path-validation';
import { publicProcedure, router } from '../index';

async function assertWorktreeBasePathWritable(normalizedPath: string): Promise<void> {
  await fs.mkdir(normalizedPath, { recursive: true });
  const probePath = path.join(normalizedPath, `.frink-write-test-${Date.now()}.tmp`);
  try {
    await fs.writeFile(probePath, 'ok', 'utf-8');
  } finally {
    await fs.unlink(probePath).catch(() => {
      // Best-effort cleanup of probe file.
    });
  }
}

export async function validateAndNormalizeWorktreeBasePath(inputPath: string): Promise<string> {
  if (!isAbsoluteWorktreeBasePathInput(inputPath)) {
    throw new Error('Worktree base path must be an absolute path');
  }

  const normalizedPath = normalizeWorktreeBasePath(inputPath);

  if (isSensitiveWorktreeBasePath(normalizedPath)) {
    throw new Error('Please choose a more specific directory for worktrees');
  }

  await assertWorktreeBasePathWritable(normalizedPath);
  return normalizedPath;
}

export const claudeSettingsRouter = router({
  /**
   * Capabilities of the bundled Claude Code CLI that the renderer needs to gate UI on.
   * `supportsXhigh`: whether the bundled binary accepts `--effort xhigh` (>= 2.1.173); when false,
   * the model picker greys the Extra High tier (the executor also clamps xhigh->high as a backstop).
   * `supportsUltra`: whether it runs Ultra at any effort; when false the picker hides the switch.
   */
  getBundledClaudeCapabilities: publicProcedure.query(() => {
    const version = getBundledClaudeVersion();
    return {
      version,
      supportsXhigh: claudeVersionSupportsXhigh(version),
      supportsUltra: claudeVersionSupportsUltra(version),
    };
  }),

  /**
   * Get current worktree base path setting
   */
  getWorktreeBasePath: publicProcedure.query(async () => {
    const resolvedPath = await resolveWorktreeBasePath();
    const isDefault = path.resolve(resolvedPath) === path.resolve(DEFAULT_WORKTREE_BASE_PATH);

    return {
      path: resolvedPath,
      defaultPath: DEFAULT_WORKTREE_BASE_PATH,
      configPath: FRINK_WORKTREE_CONFIG_PATH,
      isDefault,
    };
  }),

  /**
   * Set global worktree base path
   */
  setWorktreeBasePath: publicProcedure
    .input(z.object({ path: z.string().min(1).max(1000) }))
    .mutation(async ({ input }) => {
      const normalizedPath = await validateAndNormalizeWorktreeBasePath(input.path);
      const savedPath = await setWorktreeBasePath(normalizedPath);
      return {
        success: true,
        path: savedPath,
      };
    }),

  /**
   * Reset worktree base path to default
   */
  resetWorktreeBasePath: publicProcedure.mutation(async () => {
    await resetWorktreeBasePath();
    return {
      success: true,
      path: DEFAULT_WORKTREE_BASE_PATH,
    };
  }),
});
