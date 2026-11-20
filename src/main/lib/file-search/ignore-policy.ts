/** Names the file tree and both searches leave out. Search does not read .gitignore. */
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  '.output',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
  '.parcel-cache',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

const IGNORED_EXTENSIONS = new Set([
  '.log',
  '.lock', // lock files are kept through ALLOWED_LOCK_FILES
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.obj',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);

const ALLOWED_LOCK_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
]);

export function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

export function isIgnoredFileByName(name: string): boolean {
  if (IGNORED_FILES.has(name)) return true;
  const ext = name.includes('.') ? `.${name.split('.').pop()?.toLowerCase()}` : '';
  if (!IGNORED_EXTENSIONS.has(ext)) return false;
  return !ALLOWED_LOCK_FILES.has(name);
}
