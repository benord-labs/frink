import * as nodePath from 'node:path';
import { braceSpellings, envGlobAsks } from '../../../agent-runner/env-file-reads';
import { isSystemDeniedPath } from '../system-denied-patterns';
import type { PermissionResult } from '../types';

/** The file filters on a Grep: ripgrep's `--glob` and `--type`. */
export type GrepFilterInput = { glob?: unknown; type?: unknown };

// A leading ! only leaves files out, and never un-hides or un-ignores one; !( and !! are judged.
const EXCLUSION = /^!(?![!(])/;

const isUnset = (value: unknown) => value === undefined || value === null || value === '';

/** The globs a filter can stand for: whole, and split at spaces and commas, as a search may pass
 * each part to ripgrep on its own. Judging a part on its own is only ever stricter. */
function filterGlobs(glob: string): string[] {
  const words = glob.split(/\s+/).filter(Boolean);
  const parts = words.flatMap((word) => word.split(',').filter(Boolean));
  return [...new Set([glob, ...words, ...parts])].filter((each) => !EXCLUSION.test(each));
}

/**
 * A Grep's file filter in a linked folder, judged as the Read question Copilot and Cursor ask for
 * theirs. Ripgrep searches a file a glob names even when the file is hidden or ignored, so a filter
 * is how a search reaches an env file or a file on the deny list. Gives the deny for a glob naming
 * a file on the deny list, `ask` for one that can reach an env file, for a type (ripgrep turns it
 * into globs Frink cannot see, and its `sh` type takes in .env) or for a filter Frink cannot read,
 * and undefined when the filter changes nothing. A Glob is never judged here: it lists names and
 * opens no file, as a name search by Copilot or Cursor does.
 */
export function grepFilterResult(
  input: GrepFilterInput,
  root: string,
  ask: PermissionResult,
): PermissionResult | undefined {
  if (!isUnset(input.type)) return ask;
  if (isUnset(input.glob)) return undefined;
  if (typeof input.glob !== 'string') return ask;
  const globs = filterGlobs(input.glob);
  const spellings = globs.map(braceSpellings);
  if (spellings.some((each) => each === undefined)) return ask;
  const denied = spellings
    .flatMap((each) => each ?? [])
    .map((glob) => nodePath.join(root, glob))
    .find((file) => isSystemDeniedPath(file));
  if (denied !== undefined) {
    return { decision: 'deny', reason: { kind: 'safety:path', path: denied } };
  }
  return globs.some(envGlobAsks) ? ask : undefined;
}
