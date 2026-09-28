/**
 * Tool Permission Validation Helpers
 *
 * Shared utilities for validating tool permissions in both:
 * - tRPC router (local execution)
 * - Socket executor (remote execution)
 */

import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { z } from 'zod';
import {
  PATH_TOOLS,
  SEARCH_TOOLS,
  TOOL_OPERATIONS,
  type ToolOperation,
} from '../../../shared/types/permissions';
import { resolveProjectPathFromWorktree } from '../claude-config';
import { searchRootFromInput } from './v2/search';

// ============================================================================
// Types
// ============================================================================

const pathToolInputSchema = z
  .object({
    file_path: z.unknown().optional(),
    file: z.unknown().optional(),
    path: z.unknown().optional(),
    command: z.unknown().optional(),
  })
  .passthrough();
type PathToolInput = z.input<typeof pathToolInputSchema>;
type PathToolField = 'file_path' | 'file' | 'path' | 'command';

function stringField(input: PathToolInput, name: PathToolField): string | null {
  const parsed = z.string().safeParse(input[name]);
  return parsed.success ? parsed.data : null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract file path or bash command from tool input
 */
export function extractFilePathFromToolInput(
  toolName: string,
  toolInput: PathToolInput,
): string | null {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Delete':
    case 'MultiEdit':
    case 'NotebookEdit': {
      // Claude/SDK may send "file" for "file_path"; the PreToolUse hook gets raw input before normalization
      return (
        stringField(toolInput, 'file_path') ??
        stringField(toolInput, 'file') ??
        stringField(toolInput, 'path')
      );
    }
    case 'Bash': {
      const command = stringField(toolInput, 'command');
      return command ? `bash:${command}` : null;
    }
    case 'Glob':
    case 'Grep':
      // Search tools are gated on their root: see `resolveSearchPermissionPath`.
      return null;
    default:
      return null;
  }
}

/**
 * Determine operation type from tool name. Reads the canonical `TOOL_OPERATIONS`
 * map in shared types — adding a new tool to that record automatically extends
 * this function's coverage.
 */
export function getOperationFromToolName(toolName: string): ToolOperation | null {
  return TOOL_OPERATIONS[toolName] ?? null;
}

/**
 * Resolve canonical permission project path from an execution path.
 * Worktree execution paths map to their owning root project path.
 */
export function resolvePermissionProjectPath(executionPath: string): string {
  return resolveProjectPathFromWorktree(executionPath) ?? executionPath;
}

/**
 * Remap absolute worktree file paths into the canonical permission project path.
 * Paths outside the execution root are preserved.
 */
export function remapPathForPermissionBoundary(
  filePath: string,
  executionPath: string,
  permissionProjectPath: string,
): string {
  const resolvedExecutionPath = nodePath.resolve(executionPath);
  const resolvedFilePath = nodePath.isAbsolute(filePath)
    ? nodePath.resolve(filePath)
    : nodePath.resolve(resolvedExecutionPath, filePath);
  const resolvedPermissionPath = nodePath.resolve(permissionProjectPath);

  if (resolvedExecutionPath === resolvedPermissionPath) {
    return resolvedFilePath;
  }

  if (resolvedFilePath === resolvedExecutionPath) {
    return resolvedPermissionPath;
  }

  const executionPrefix = resolvedExecutionPath.endsWith(nodePath.sep)
    ? resolvedExecutionPath
    : `${resolvedExecutionPath}${nodePath.sep}`;

  if (!resolvedFilePath.startsWith(executionPrefix)) {
    return resolvedFilePath;
  }

  const relativePath = resolvedFilePath.slice(executionPrefix.length);
  return nodePath.join(resolvedPermissionPath, relativePath);
}

/** Whether Claude's provider hook delegates this built-in tool to Frink permissions. */
export function isClaudePermissionGatedTool(toolName: string): boolean {
  return (
    toolName === 'Bash' || toolName === 'Glob' || toolName === 'Grep' || PATH_TOOLS.has(toolName)
  );
}

/** Resolve a file-tool input to the canonical path used by the permission gate. */
export function resolveToolPermissionPath(
  toolName: string,
  toolInput: PathToolInput,
  executionPath: string,
  permissionProjectPath: string,
): string | undefined {
  const candidate = extractFilePathFromToolInput(toolName, toolInput);
  if (!candidate || candidate.startsWith('bash:')) return undefined;
  return remapPathForPermissionBoundary(
    nodePath.resolve(executionPath, candidate),
    executionPath,
    permissionProjectPath,
  );
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/** Canonical Glob/Grep search root. Resolved in the EXECUTION tree first: if the path goes
 * through a symlink there, it stays un-remapped so the gate realpaths the tree actually read. */
export async function resolveSearchPermissionPath(
  toolName: string,
  toolInput: unknown,
  executionPath: string,
  permissionProjectPath: string,
): Promise<string> {
  const exec = nodePath.resolve(executionPath);
  const absolute = nodePath.resolve(exec, searchRootFromInput(toolName, toolInput));
  const [real, realExec] = await Promise.all([realpathOr(absolute), realpathOr(exec)]);
  const viaSymlink = nodePath.relative(realExec, real) !== nodePath.relative(exec, absolute);
  return viaSymlink
    ? absolute
    : remapPathForPermissionBoundary(absolute, executionPath, permissionProjectPath);
}

/** Permission-path override for any gated tool: search roots async, file paths lexically. */
export async function resolvePermissionPathOverride(
  toolName: string,
  toolInput: PathToolInput,
  executionPath: string,
  permissionProjectPath: string,
): Promise<string | undefined> {
  if (SEARCH_TOOLS.has(toolName)) {
    return resolveSearchPermissionPath(toolName, toolInput, executionPath, permissionProjectPath);
  }
  return resolveToolPermissionPath(toolName, toolInput, executionPath, permissionProjectPath);
}
