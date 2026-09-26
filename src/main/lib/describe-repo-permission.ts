import { isPathWithinProject } from './permissions/path-check';

/**
 * Allow only Read/Glob/Grep within projectPath. Deny everything else.
 */
export function allowReadOnlyUnderProject(
  projectPath: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): { allowed: boolean; message?: string } {
  const allowedTools = new Set(['Read', 'Glob', 'Grep']);
  if (!allowedTools.has(toolName)) {
    return { allowed: false, message: 'Only Read, Glob, Grep are allowed for description.' };
  }
  if (toolName === 'Read' && typeof toolInput.file_path === 'string') {
    if (!isPathWithinProject(toolInput.file_path, projectPath)) {
      return { allowed: false, message: 'Read only allowed within project.' };
    }
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const base = String(toolInput.path ?? toolInput.directory ?? '.');
    if (!isPathWithinProject(base, projectPath)) {
      return { allowed: false, message: 'Glob/Grep only allowed within project.' };
    }
  }
  return { allowed: true };
}
