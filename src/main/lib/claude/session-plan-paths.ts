import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import { isPathWithinProject } from '../permissions';

const CLAUDE_PLANS_DIR = ['.claude', 'plans'] as const;
const SUBCHAT_ID_PATH_SAFE_RE = /^[a-z0-9-]{10,64}$/i;

export function isValidSubChatIdForSessionPaths(id: string): boolean {
  return SUBCHAT_ID_PATH_SAFE_RE.test(id);
}

function getClaudePlansDir(): string {
  return path.join(app.getPath('home'), ...CLAUDE_PLANS_DIR);
}

function assertSafeSubChatIdForSessionPlans(subChatId: string): void {
  if (typeof subChatId !== 'string') throw new TypeError('subChatId must be a string');
  if (subChatId !== subChatId.trim()) {
    throw new Error('subChatId must not have leading or trailing whitespace');
  }
  if (!subChatId) throw new Error('subChatId is required for session plans directory');
  if (subChatId.includes('..')) {
    throw new Error('Invalid subChatId: path traversal is not allowed');
  }
  if (subChatId.includes('/') || subChatId.includes('\\')) {
    throw new Error('Invalid subChatId: path separators are not allowed');
  }
  if (!isValidSubChatIdForSessionPaths(subChatId)) {
    throw new Error('Invalid subChatId for session plans directory');
  }
}

export function getClaudeSessionPlansDir(subChatId: string): string {
  assertSafeSubChatIdForSessionPlans(subChatId);
  const base = path.resolve(app.getPath('userData'), 'claude-sessions');
  const resolved = path.resolve(base, subChatId, 'plans');
  if (!isPathWithinProject(resolved, base)) {
    throw new Error('Session plans directory resolved outside allowed base path');
  }
  return resolved;
}

/** Single source of truth for plan-mode Write targets (global ~/.claude/plans or session plans/). */
export function isAllowedClaudePlanWritePath(resolvedAbsolute: string, subChatId: string): boolean {
  if (isPathWithinProject(resolvedAbsolute, getClaudePlansDir())) return true;
  if (!isValidSubChatIdForSessionPaths(subChatId)) return false;
  return isPathWithinProject(resolvedAbsolute, getClaudeSessionPlansDir(subChatId));
}

/** The CLI adds these to ExitPlanMode's input before hooks run. An empty `plan` means it could not
 * read the file, so the path is not trusted and the plans-dir scan decides instead. */
const exitPlanModeInputSchema = z.object({ planFilePath: z.string(), plan: z.string().min(1) });

/**
 * The plan the CLI submits in an ExitPlanMode call's input (its file and exact text), else null. Preferred over
 * {@link resolveLatestSessionPlanFile} because it names the exact file this call submits — a stale
 * sibling in the plans dir can never win a newest-mtime race onto the approval card.
 */
export function submittedPlanFromExitPlanModeInput(
  input: unknown,
  subChatId: string,
): { path: string; text: string } | null {
  const parsed = exitPlanModeInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const { planFilePath, plan } = parsed.data;
  // Reject relative paths: isPathWithinProject resolves them against its base, so "plan.md" would
  // clear containment while the returned string reads from cwd.
  if (!path.isAbsolute(planFilePath)) return null;
  return isAllowedClaudePlanWritePath(planFilePath, subChatId)
    ? { path: planFilePath, text: plan }
    : null;
}

/**
 * Newest-mtime plan `.md` in this sub-chat's session plans dir, else null. Never throws: callers
 * sit on the plan-submission-halt path, where a throw would skip the halt and let the model keep
 * implementing before approval. Deliberately narrower than `isAllowedClaudePlanWritePath`: the
 * machine-global ~/.claude/plans is shared by every session on the machine, so a newest-file scan
 * there could attribute another chat's plan to this one.
 */
export async function resolveLatestSessionPlanFile(subChatId: string): Promise<string | null> {
  if (!isValidSubChatIdForSessionPaths(subChatId)) return null;
  try {
    const dir = getClaudeSessionPlansDir(subChatId);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let latest: { filePath: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      const filePath = path.join(dir, entry.name);
      const { mtimeMs } = await fs.promises.stat(filePath);
      if (!latest || mtimeMs > latest.mtimeMs) latest = { filePath, mtimeMs };
    }
    return latest?.filePath ?? null;
  } catch {
    return null;
  }
}

/** Absolute path of a plan-dir `.md` mutation in plan mode, else null. */
export function planWritePathFromInput(
  input: unknown,
  projectPath: string,
  subChatId: string,
): string | null {
  const fp = (input as { file_path?: string } | undefined)?.file_path;
  if (typeof fp !== 'string') return null;
  const resolved = path.isAbsolute(fp) ? fp : path.resolve(projectPath, fp);
  if (path.extname(resolved).toLowerCase() !== '.md') return null;
  return isAllowedClaudePlanWritePath(resolved, subChatId) ? resolved : null;
}
