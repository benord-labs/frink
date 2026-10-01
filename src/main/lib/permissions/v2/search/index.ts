/** Glob/Grep checker: Read parity on the folder a search reads. In-project searches stay
 * prompt-free; anything else goes to rules, then the prompt or Auto. */

import * as nodePath from 'node:path';
import { isPathWithinProject } from '../../path-check';
import { expandTilde } from '../check-edit';
import { combineScopes, evalScope, resultFromCombined, type ScopedDocs } from '../eval-rules';
import { isSystemDeniedPath, SYSTEM_DENIED_EXACT } from '../system-denied-patterns';
import type { PermissionResult } from '../types';

export type SearchInput = { path?: unknown; pattern?: unknown };

/** A Glob pattern that is absolute, home-relative or climbs with `..` reads outside its root. */
const ESCAPING_GLOB = /^(?:[/\\~]|[A-Za-z]:)|(?:^|[/\\{,])\.\.(?:[/\\},]|$)/;

/** The folder the search reads: its `path`, else the project root. */
export function searchRoot(input: SearchInput, projectRoot: string): string {
  const raw = typeof input.path === 'string' && input.path ? input.path : projectRoot;
  return nodePath.resolve(projectRoot, expandTilde(raw));
}

export function checkSearch(
  tool: 'Glob' | 'Grep',
  input: SearchInput,
  docs: ScopedDocs,
  projectRoot: string,
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

  // Same rule for every chat (general-chat-permission-parity); a folder holding a protected
  // folder (a search of `~`) would read inside it, so that one asks.
  const escapes =
    tool === 'Glob' && typeof input.pattern === 'string' && ESCAPING_GLOB.test(input.pattern);
  const spansProtected = SYSTEM_DENIED_EXACT.some((entry) => isPathWithinProject(entry, root));
  if (!escapes && !spansProtected && isPathWithinProject(root, projectRoot)) {
    return { decision: 'allow' };
  }
  result.prompt.suggestedRules = [tool];
  return result;
}
