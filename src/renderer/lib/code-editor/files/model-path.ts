const TRAILING_SLASHES = /\/+$/;
const LEADING_TRAILING_SLASHES = /^\/+|\/+$/g;

function joinPath(...parts: string[]): string {
  return parts
    .map((part, i) => {
      if (i === 0) return part.replace(TRAILING_SLASHES, '');
      return part.replace(LEADING_TRAILING_SLASHES, '');
    })
    .filter(Boolean)
    .join('/');
}

export function getFullPath(projectPath: string | undefined, path: string): string {
  if (path.startsWith('/')) return path;
  if (!projectPath) return path;
  return joinPath(projectPath, path);
}

export function buildFileModelPath(projectPath: string | undefined, path: string): string {
  return `file://${encodeURI(getFullPath(projectPath, path))}`;
}
