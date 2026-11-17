import { isAbsolute, relative, sep } from 'node:path';
import { secureFs } from '../../git/security/secure-fs';

export type SymlinkEscape = { escapes: false } | { escapes: true; realPath: string };

/** files.symlinkEscape: a file's real path when it lives outside the project it was
 * browsed from. Feeds a notice, never a gate, so it reports no escape instead of throwing. */
export async function findSymlinkEscape(
  projectPath: string,
  filePath: string,
): Promise<SymlinkEscape> {
  // A relative path would resolve against the main process's cwd, not the user's project.
  if (!isAbsolute(projectPath) || !isAbsolute(filePath)) {
    return { escapes: false };
  }

  const relativePath = relative(projectPath, filePath);
  // Lexically outside the project (or the root itself): opened by path, so nothing is lying.
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return { escapes: false };
  }

  const realPath = await secureFs.escapeTarget(projectPath, relativePath);
  return realPath === null ? { escapes: false } : { escapes: true, realPath };
}
