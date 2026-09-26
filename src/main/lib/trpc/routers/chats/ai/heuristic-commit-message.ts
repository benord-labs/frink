import path from 'node:path';
import type { ParsedDiffFile } from '../../../../git/diff-parser';

/** The path a diff entry reports for its post-change state; `/dev/null` means it was deleted. */
function effectivePath(file: ParsedDiffFile): string {
  return file.newPath !== '/dev/null' ? file.newPath : file.oldPath;
}

/** What a diff looks like, reduced to the traits the prefix rules below ask about. */
type DiffTraits = {
  added: boolean;
  deleted: boolean;
  onlyDeletions: boolean;
  tests: boolean;
  docs: boolean;
  config: boolean;
  namedFix: boolean;
  allModified: boolean;
};

function isConfigPath(p: string): boolean {
  return (
    p.includes('config') ||
    p.endsWith('.json') ||
    p.endsWith('.yaml') ||
    p.endsWith('.yml') ||
    p.endsWith('.toml')
  );
}

function readTraits(files: ParsedDiffFile[], allPaths: string[]): DiffTraits {
  return {
    added: files.some((f) => f.oldPath === '/dev/null'),
    deleted: files.some((f) => f.newPath === '/dev/null'),
    onlyDeletions: files.every((f) => f.additions === 0 && f.deletions > 0),
    tests: allPaths.some((p) => p.includes('test') || p.includes('spec')),
    docs: allPaths.some((p) => p.endsWith('.md') || p.includes('doc')),
    config: allPaths.some(isConfigPath),
    namedFix: allPaths.some((p) => p.includes('fix') || p.includes('bug')),
    allModified: files.length > 0 && files.every((f) => f.additions > 0 || f.deletions > 0),
  };
}

/** Conventional-commit types in precedence order; the first match wins, else `chore`. */
const PREFIX_RULES: readonly (readonly [string, (t: DiffTraits) => boolean])[] = [
  ['feat', (t) => t.added && !t.deleted],
  ['chore', (t) => t.onlyDeletions],
  ['test', (t) => t.tests && !t.docs && !t.config],
  ['docs', (t) => t.docs && !t.tests && !t.config],
  ['fix', (t) => t.namedFix || t.allModified],
];

/** Conventional-commit message derived from the diff alone. Pure: no I/O. */
export function buildHeuristicCommitMessage(files: ParsedDiffFile[]): string {
  const allPaths = files.map(effectivePath);
  const traits = readTraits(files, allPaths);
  const prefix = PREFIX_RULES.find(([, matches]) => matches(traits))?.[0] ?? 'chore';
  const uniqueFileNames = [...new Set(allPaths.map((p) => path.posix.basename(p) || p))];

  if (uniqueFileNames.length === 1) return `${prefix}: update ${uniqueFileNames[0]}`;
  if (uniqueFileNames.length <= 3) return `${prefix}: update ${uniqueFileNames.join(', ')}`;
  return `${prefix}: update ${uniqueFileNames.length} files`;
}
