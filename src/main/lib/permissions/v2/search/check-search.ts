/** Glob / Grep checker: gates the directory a search can read. Deny wins, then home-spanning
 * roots ask, then app-owned and in-project roots allow, then rules, else ask. */

import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import type { PathLocation } from '../../../../../shared/types/permissions';
import { getSkillReadRoots } from '../../../frink-skills-dir';
import {
  type CombinedDecision,
  combineScopes,
  evalScope,
  resultFromCombined,
  type ScopedDocs,
} from '../eval-rules';
import { searchTargetsProtectedPath } from './protected-selector';
import { foldCase, searchRootFromInput } from './search-root';
import { isSystemDeniedPath, SYSTEM_DENIED_EXACT } from '../system-denied-patterns';
import type { MatchContext, PermissionResult } from '../types';

export type SearchToolName = 'Glob' | 'Grep';

export type SearchContext = {
  /** Empty when no project row matches (general chat / virtual folder). */
  projectId: string;
  /** Host-resolved absolute root (see `SEARCH_ROOT` in `../context/request-context.ts`). */
  searchRoot?: string;
  sessionDirRoot?: string;
  planDirRoot?: string;
  skillsDirRoots?: string[];
};

// `isSystemDeniedPath`'s dir-globs (`**/.ssh/**`) only match paths INSIDE the dir,
// so a bare `<proj>/.aws` root needs a child probe to be recognised.
const DENY_PROBE = '__frink_search_probe__';

// A `.env.example` root is a public template; any symlink it is has already been followed into
// `real`, so skip the matcher's own synchronous symlink chase for it.
const isEnvExample = (p: string) => foldCase(nodePath.basename(p)) === '.env.example';

// On case-insensitive filesystems (macOS / Windows) `.SSH` is `.ssh`: also check the folded path.
function isDeniedRoot(root: string, projectRoot: string): boolean {
  return [root, foldCase(root)].some(
    (candidate) =>
      (!isEnvExample(candidate) && isSystemDeniedPath(candidate, projectRoot)) ||
      isSystemDeniedPath(nodePath.join(candidate, DENY_PROBE), projectRoot),
  );
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** `child` equals or lies under `parent` (lexical; callers pass resolved paths). */
function isWithin(child: string, parent: string): boolean {
  const prefix = parent.endsWith(nodePath.sep) ? parent : `${parent}${nodePath.sep}`;
  return norm(child) === norm(parent) || norm(child).startsWith(norm(prefix));
}

/** Async realpath (keeps the main event loop free); a missing path stays as given. */
async function realpathOr(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/** Marker a Frink-shipped skill folder carries (same trust signal as check-edit's Read). */
const SHIPPED_SKILL_MARKER = '.baseline.json';

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** App-owned read areas, mirroring check-edit's Read allow-lists: session paste blobs and CLI
 * tool-result spills, the chat's plan dir, and marker-bearing shipped skill folders. */
async function isAppOwnedRoot(real: string, ctx: SearchContext): Promise<boolean> {
  const inSession = async (sessionDir: string) => {
    const session = await realpathOr(sessionDir);
    if (isWithin(real, nodePath.join(session, 'pasted'))) return true;
    const parts = nodePath.relative(session, real).split(nodePath.sep);
    return isWithin(real, nodePath.join(session, 'projects')) && parts.includes('tool-results');
  };
  const inShippedSkill = async (root: string) => {
    const realRoot = await realpathOr(root);
    if (!isWithin(real, realRoot)) return false;
    const skill = nodePath.relative(realRoot, real).split(nodePath.sep)[0];
    return !!skill && exists(nodePath.join(realRoot, skill, SHIPPED_SKILL_MARKER));
  };
  // Independent probes: run them concurrently rather than one after another.
  const probes = await Promise.all([
    ctx.sessionDirRoot ? inSession(ctx.sessionDirRoot) : false,
    ctx.planDirRoot ? realpathOr(ctx.planDirRoot).then((plan) => isWithin(real, plan)) : false,
    ...(ctx.skillsDirRoots ?? getSkillReadRoots()).map(inShippedSkill),
  ]);
  return probes.some(Boolean);
}

/** Rule-matching form of a root: project-relative inside the project, absolute outside
 * (picomatch is anchored, so `Grep(src/**)` and `Grep(/etc/**)` both work). */
function matchPathFor(root: string, project: string): string {
  const relative = nodePath.relative(project, root);
  const outside =
    relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative);
  return relative === '' ? '.' : outside ? root : relative;
}

/** First system-denied exact path that lives under `root`, if any (lexical, no walk). */
function deniedDescendant(root: string): string | undefined {
  return SYSTEM_DENIED_EXACT.find(
    (denied) => foldCase(denied) !== foldCase(root) && isWithin(foldCase(denied), foldCase(root)),
  );
}

type Roots = { absolute: string; real: string; realProject: string; projectRoot: string };
type Request = { input: unknown; docs: ScopedDocs; toolName: SearchToolName; ctx: SearchContext };

async function resolveRoots(req: Request, projectRoot: string): Promise<Roots> {
  const rawRoot = req.ctx.searchRoot ?? searchRootFromInput(req.toolName, req.input);
  const absolute = nodePath.resolve(projectRoot, rawRoot);
  const [real, realProject] = await Promise.all([realpathOr(absolute), realpathOr(projectRoot)]);
  return { absolute, real, realProject, projectRoot };
}

function evalRules(req: Request, resolvedPath: string): CombinedDecision {
  const matchCtx: MatchContext = { resolvedPath };
  return combineScopes(
    evalScope(req.docs.policy, req.toolName, req.input, matchCtx),
    evalScope(req.docs.project, req.toolName, req.input, matchCtx),
    evalScope(req.docs.user, req.toolName, req.input, matchCtx),
  );
}

/** A root reached through a symlink: the link could be retargeted before the search runs. */
function reachedViaSymlink(roots: Roots): boolean {
  const lexical = nodePath.relative(nodePath.resolve(roots.projectRoot), roots.absolute);
  return (
    roots.real !== roots.absolute && nodePath.relative(roots.realProject, roots.real) !== lexical
  );
}

/** Home-spanning roots, selectors naming a protected path, and symlinked roots always ask. */
function mustAsk(req: Request, roots: Roots): boolean {
  return (
    !!deniedDescendant(roots.absolute) ||
    !!deniedDescendant(roots.real) ||
    searchTargetsProtectedPath(req.toolName, req.input) ||
    reachedViaSymlink(roots)
  );
}

/** In-project roots allow unless an ask rule matched; rule allows stand, except a project-wide
 * grant on an outside root. */
function allowedByContainmentOrRule(
  req: Request,
  combined: CombinedDecision,
  pathLocation: PathLocation,
): boolean {
  const explicitAsk = combined.decision === 'ask' && combined.rule !== undefined;
  if (req.ctx.projectId && pathLocation === 'in-current-project' && !explicitAsk) return true;
  if (combined.decision !== 'allow') return false;
  const toolWide = combined.rule === req.toolName || combined.rule === `${req.toolName}(*)`;
  return !(combined.tier === 'project' && pathLocation === 'outside' && toolWide);
}

export async function checkSearch(
  input: unknown,
  docs: ScopedDocs,
  projectRoot: string,
  toolName: SearchToolName,
  ctx: SearchContext,
): Promise<PermissionResult> {
  const req: Request = { input, docs, toolName, ctx };
  const roots = await resolveRoots(req, projectRoot);
  if (isDeniedRoot(roots.absolute, projectRoot) || isDeniedRoot(roots.real, projectRoot)) {
    return { decision: 'deny', reason: { kind: 'safety:path', path: roots.absolute } };
  }

  // Allow/ask rules judge the symlink-resolved root, so a lexical `src/escape -> /etc` cannot
  // borrow `Grep(src/**)`; a deny on either the lexical or the resolved form still denies.
  const combined = evalRules(req, matchPathFor(roots.real, roots.realProject));
  const lexical = evalRules(req, matchPathFor(roots.absolute, projectRoot));
  const denied = [combined, lexical].find((decision) => decision.decision === 'deny');
  if (denied) return resultFromCombined(denied, toolName, input);

  const pathLocation: PathLocation =
    projectRoot && isWithin(roots.real, roots.realProject) ? 'in-current-project' : 'outside';
  const ask = (): PermissionResult => {
    const result = resultFromCombined(
      combined.decision === 'ask' ? combined : { decision: 'ask' },
      toolName,
      input,
    );
    if (result.decision === 'ask') {
      result.prompt.pathLocation = pathLocation;
      result.prompt.suggestedRules = [];
    }
    return result;
  };

  if (mustAsk(req, roots)) return ask();
  // Judged on the fully resolved root, so a symlink cannot borrow an app-owned area's trust.
  if (await isAppOwnedRoot(roots.real, ctx)) return { decision: 'allow' };
  return allowedByContainmentOrRule(req, combined, pathLocation) ? { decision: 'allow' } : ask();
}
