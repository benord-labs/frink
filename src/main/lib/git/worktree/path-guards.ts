import { isAbsolute, relative, resolve, sep } from 'node:path';

/** True when `candidatePath` is strictly below `rootPath` (lexically, symlinks not resolved). */
export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const fromRoot = relative(resolve(rootPath), resolve(candidatePath));
  return (
    Boolean(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}
