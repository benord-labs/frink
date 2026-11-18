/** Glob/Grep checker: Read parity on the folder a search reads. In-project searches stay
 * prompt-free; anything else goes to rules, then the prompt or Auto. */

import * as nodePath from 'node:path';
import { z } from 'zod';
import { braceSpellings } from '../../../agent-runner/env-file-reads';
import { isPathWithinProject } from '../../path-check';
import { expandTilde } from '../check-edit';
import { combineScopes, evalScope, resultFromCombined, type ScopedDocs } from '../eval-rules';
import { hasUnsafePathText, isPastedSearchRoot } from '../session-read';
import { isSystemDeniedPath, SYSTEM_DENIED_EXACT } from '../system-denied-patterns';
import type { PermissionResult } from '../types';

export type SearchInput = { path?: unknown; pattern?: unknown };

/** A brace-free Glob pattern that is absolute, home-relative or climbs with `..` reads outside its
 * root. */
const ESCAPING_GLOB = /^(?:[/\\~]|[A-Za-z]:)|(?:^|[/\\])\.\.(?:[/\\]|$)/;
/** An extended group holding a folder break, `~` or `..` can name a folder outside the root. */
const ESCAPING_GROUP = /\([^)]*(?:[/\\~]|\.\.)/;

/** True when a Glob pattern can read outside its root. Braces are spelled out before a search
 * walks, so each spelling is judged on its own (`{src,/etc}/*` and `.{.,x}/*` climb out; a
 * backup suffix such as `*.{bak,~}` does not). Too many spellings to check counts as climbing. */
function globEscapes(pattern: string): boolean {
  if (ESCAPING_GROUP.test(pattern)) return true;
  const spellings = braceSpellings(pattern);
  return !spellings || spellings.some((spelling) => ESCAPING_GLOB.test(spelling));
}

const TEXT = z.string();

/** A search of this chat's pasted/ folder, judged on the path as written as well as resolved. */
function readsOwnAttachments(input: SearchInput, root: string, sessionDirRoot?: string): boolean {
  if (!sessionDirRoot) return false;
  const written = TEXT.safeParse(input.path);
  if (!written.success || hasUnsafePathText(written.data)) return false;
  return isPastedSearchRoot(root, nodePath.join(sessionDirRoot, 'pasted'));
}

/** The folder the search reads: its `path`, else the project root. */
export function searchRoot(input: SearchInput, projectRoot: string): string {
  const raw = typeof input.path === 'string' && input.path ? input.path : projectRoot;
  return nodePath.resolve(projectRoot, expandTilde(raw));
}

/** True when a search of `root` reads only inside it: a Glob pattern can't climb out, and the
 * folder holds no protected folder (a search of `~` would read inside `~/.ssh`). Any other tool
 * counts as a search of `root` itself, as a Read of a folder is. */
export function searchStaysInRoot(tool: string, input: SearchInput, root: string): boolean {
  const escapes =
    tool === 'Glob' && typeof input.pattern === 'string' && globEscapes(input.pattern);
  return !escapes && !SYSTEM_DENIED_EXACT.some((entry) => isPathWithinProject(entry, root));
}

export function checkSearch(
  tool: 'Glob' | 'Grep',
  input: SearchInput,
  docs: ScopedDocs,
  projectRoot: string,
  sessionDirRoot?: string,
): PermissionResult {
  const root = searchRoot(input, projectRoot);
  if (isSystemDeniedPath(root, projectRoot)) {
    return { decision: 'deny', reason: { kind: 'safety:path', path: root } };
  }

  const policy = evalScope(docs.policy, tool, input);
  const project = evalScope(docs.project, tool, input);
  const user = evalScope(docs.user, tool, input);
  const result = resultFromCombined(combineScopes(policy, project, user), tool, input);
  if (result.decision !== 'ask') return result;

  // Same rule for every chat (general-chat-permission-parity). The chat's own attachments folder
  // reads like the project, unless the user's own ask rule matched.
  const ownAttachments =
    result.prompt.reason === 'no-matching-rule' && readsOwnAttachments(input, root, sessionDirRoot);
  if (
    searchStaysInRoot(tool, input, root) &&
    (ownAttachments || isPathWithinProject(root, projectRoot))
  ) {
    return { decision: 'allow' };
  }
  result.prompt.suggestedRules = [tool];
  return result;
}
