/** Linked-project reads: Read, Glob and Grep inside a folder linked to the chat run without
 * asking. Applied to a checker's result, so the deny list and every rule have already run; it
 * only ever turns an ask that names no rule into an allow, or into a deny or an ask that does,
 * and an allow from the chat's own rules into a deny or an ask the linked project's rules give, or
 * a Read rule of the chat's gives for a searched folder. Such an ask offers no lasting rule. */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import picomatch from 'picomatch';
import { parseRule } from '../../../../../shared/lib/rule-parser';
import { envFileAsks, envGlobAsks } from '../../../agent-runner/env-file-reads';
import { isPathWithinProject, resolveToRealPath } from '../../path-check';
import { combineFileRules, expandTilde, type FileOpInput, ruleMatchPath } from '../check-edit';
import { classifyPath } from '../classify-path';
import {
  type CombinedDecision,
  evalScope,
  resultFromCombined,
  type ScopedDocs,
  type ScopeEval,
} from '../eval-rules';
import { searchRoot, searchStaysInRoot, type SearchInput } from '../search';
import { isSystemDeniedPath } from '../system-denied-patterns';
import type { LinkedRoot, PermissionRequest, PermissionResult, PermissionsDoc } from '../types';
import { type GrepFilterInput, grepFilterResult } from './grep-filter';
import { isRootFolder } from './root-folder';

type ReadInput = FileOpInput & SearchInput & GrepFilterInput;
type Ask = Extract<PermissionResult, { decision: 'ask' }>;
/** A linked folder holding the target, and the target's path relative to it (rule form). */
type Holder = { root: LinkedRoot; rels: string[] };
type LinkedHit = { hit: ScopeEval; projectId: string };

const LINKED_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
const SEVERITY: Record<ScopeEval['kind'], number> = { miss: 0, allow: 0, ask: 1, deny: 2 };
// Glob syntax, which the Read question for a Copilot or Cursor search filter carries.
const GLOB_CHARS = /[*?[\]{}()!]/;

/** The absolute path a Read reads or a search searches, by the checkers' own field chain. A Glob
 * whose pattern alone is absolute searches the chat's folder by this chain, so it still asks. */
function readTarget(tool: string, input: ReadInput, projectPath: string): string | null {
  if (tool === 'Glob' || tool === 'Grep') return searchRoot(input, projectPath);
  const raw = input.file_path ?? input.file ?? input.path;
  if (typeof raw !== 'string' || !raw) return null;
  return nodePath.resolve(projectPath, expandTilde(raw));
}

/** True when file is folder or inside it as written, before any link on the way is followed. */
function writtenWithin(file: string, folder: string): boolean {
  const rest = nodePath.relative(nodePath.resolve(folder), file);
  return !nodePath.isAbsolute(rest) && rest.split(nodePath.sep)[0] !== '..';
}

/** The target relative to a linked folder, as resolved and as written, with `/` breaks. */
function relPaths(folder: string, target: string, realTarget: string): string[] {
  const written = nodePath.resolve(folder);
  const rels = [
    nodePath.relative(resolveToRealPath(written), realTarget),
    nodePath.relative(written, target),
  ];
  return [...new Set(rels.map((rel) => rel.split(nodePath.sep).join('/')))];
}

/** True when a Read opens an env file, or is the question for a search filter that can reach
 * one: both ask, as they do in the chat's own folder. A filter names no file on disk, so a path
 * that exists is judged as the file it is. */
function readsEnvFile(holders: Holder[], target: string): boolean {
  const asFilter = !nodeFs.existsSync(target);
  return holders.some(({ rels }) =>
    rels.some((rel) => envFileAsks(rel) || (asFilter && GLOB_CHARS.test(rel) && envGlobAsks(rel))),
  );
}

/** The target as written, its real path, and that path under each linked folder as the folder is
 * written. The checker matched the chat's own rules only at the first, and a link must not let a
 * symlink or another letter case step around a rule. */
function chatSpellings(holders: Holder[], [target, realTarget]: [string, string]): string[] {
  const spellings = new Set([target, realTarget]);
  for (const { root } of holders) {
    const folder = nodePath.resolve(root.path);
    spellings.add(nodePath.join(folder, nodePath.relative(resolveToRealPath(folder), realTarget)));
  }
  return [...spellings];
}

/** The chat's own rules at every spelling of the target. */
function chatRulesElsewhere(
  docs: ScopedDocs,
  req: PermissionRequest,
  ask: Ask,
  spellings: string[],
): CombinedDecision {
  const location = ask.prompt.pathLocation ?? 'outside';
  const found = spellings.map((spelling) =>
    combineFileRules(docs, req.tool, req.input, ruleMatchPath(spelling, req.projectPath), location),
  );
  return (
    found.find((each) => each.decision === 'deny') ??
    found.find((each) => each.decision === 'ask' && each.rule !== undefined) ?? { decision: 'ask' }
  );
}

/** The linked project's own rules, matched at the target relative to its folder, as written and
 * as resolved, so neither a symlink nor another spelling of the folder steps around one. */
function linkedRuleHits({ root, rels }: Holder, req: PermissionRequest): LinkedHit[] {
  const { doc, projectId } = root;
  if (!doc) return [];
  return rels.map((resolvedPath) => ({
    hit: evalScope(doc, req.tool, req.input, { resolvedPath }),
    projectId,
  }));
}

function strictest(hits: LinkedHit[]): LinkedHit {
  return hits.reduce<LinkedHit>(
    (worst, each) => (SEVERITY[each.hit.kind] > SEVERITY[worst.hit.kind] ? each : worst),
    { hit: { kind: 'miss' }, projectId: '' },
  );
}

/** True for a search, or a Read of a folder (how Copilot, Cursor and OpenCode ask to search). */
function readsFolder(tool: string, realTarget: string): boolean {
  if (tool !== 'Read') return true;
  try {
    return nodeFs.statSync(realTarget, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** True for a Read, or a Grep given a file rather than a folder: ripgrep searches a file it is
 * given by name whole, even when it is ignored. A Glob only lists names. */
function opensTarget(tool: string, realTarget: string): boolean {
  return tool === 'Read' || (tool === 'Grep' && !readsFolder('Read', realTarget));
}

/** True when a Read deny or ask rule can match a file inside the folder at `rel`. Rules match a
 * file's own path, never the folder a search reads it through, so this is judged apart. */
function ruleReachesInside(doc: PermissionsDoc, rel: string): boolean {
  return [...doc.deny, ...doc.ask].some((rule) => {
    const parsed = parseRule(rule);
    if ('error' in parsed || parsed.tool !== 'Read') return false;
    if (parsed.content === undefined || parsed.content === '*') return true;
    // A negated rule matches every file outside the folder it names.
    const { base, negated } = picomatch.scan(parsed.content);
    if (negated || !base || !rel) return true;
    // A base that ends in a break, as `/` does for `/**/secrets/**`, holds everything under it.
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return base === rel || base.startsWith(`${rel}/`) || rel.startsWith(prefix);
  });
}

function reachesInside({ root, rels }: Holder): boolean {
  const { doc } = root;
  return !!doc && rels.some((rel) => ruleReachesInside(doc, rel));
}

/** True when one of the chat's own policy, project or user Read deny or ask rules can match a file
 * inside the folder at any of its spellings. Before the link, a search there asked. */
function chatRulesReachInside(docs: ScopedDocs, projectPath: string, spellings: string[]): boolean {
  return spellings.some((spelling) => {
    const at = ruleMatchPath(spelling, projectPath).split(nodePath.sep).join('/');
    return [docs.policy, docs.project, docs.user].some((doc) => ruleReachesInside(doc, at));
  });
}

/** The ask with no lasting rule to offer: one saved would be the chat's own, and these checks still
 * run after the chat's own rules allow, so it would never take effect. */
function once(ask: Ask): Ask {
  return { decision: 'ask', prompt: { ...ask.prompt, suggestedRules: [] } };
}

/** The rules' answer for a read inside linked folders: a deny wins, then an ask that names its
 * rule, and a linked project whose rules could not be loaded grants nothing. A search, or a Read
 * of a folder, asks when a Read deny or ask rule of the linked project's, or of the chat's outside
 * its own folder, can match a file inside it. */
function judge(
  ask: Ask,
  req: PermissionRequest,
  docs: ScopedDocs,
  holders: Holder[],
  targets: [string, string],
): PermissionResult {
  const spellings = chatSpellings(holders, targets);
  const chat: CombinedDecision =
    req.tool === 'Read' ? chatRulesElsewhere(docs, req, ask, spellings) : { decision: 'ask' };
  if (chat.decision === 'deny') return resultFromCombined(chat, req.tool, req.input);
  const { hit, projectId } = strictest(holders.flatMap((holder) => linkedRuleHits(holder, req)));
  if (hit.kind === 'deny') {
    return {
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: hit.rule, tier: 'project', projectId },
    };
  }
  if (chat.decision === 'ask' && chat.rule) {
    const { rule: matchedRule, tier: matchedTier } = chat;
    return {
      decision: 'ask',
      prompt: { ...ask.prompt, reason: 'rule:ask', matchedRule, matchedTier },
    };
  }
  if (holders.some(({ root }) => !root.doc)) return once(ask);
  if (hit.kind === 'ask') {
    // Only "Allow once", as in `once`, and naming the linked project the rule is saved on.
    return {
      decision: 'ask',
      prompt: {
        ...ask.prompt,
        reason: 'rule:ask',
        matchedRule: hit.rule,
        matchedTier: 'project',
        matchedProjectId: projectId,
        suggestedRules: [],
        pathLocation: 'outside',
      },
    };
  }
  if (!readsFolder(req.tool, targets[1])) return { decision: 'allow' };
  // In the chat's own folder a search meets only its own Glob and Grep rules, as with no link.
  const ours = isPathWithinProject(targets[0], req.projectPath);
  const reached =
    holders.some(reachesInside) ||
    (!ours && chatRulesReachInside(docs, req.projectPath, spellings));
  return reached ? once(ask) : { decision: 'allow' };
}

/** The links with a usable folder: one that is not an absolute path is never the app's own. */
function linkedRoots(req: PermissionRequest): LinkedRoot[] {
  return (req.linkedRoots ?? []).filter((root) => nodePath.isAbsolute(root.path));
}

/** True when file is folder or inside it, as resolved or as written. */
function within(file: string, folder: string): boolean {
  return isPathWithinProject(file, folder) || writtenWithin(file, folder);
}

/** The ask for a read the chat's own rules allow, for when the linked rules still ask. */
function askFor(req: PermissionRequest, target: string): Ask {
  return {
    decision: 'ask',
    prompt: {
      tool: req.tool,
      input: req.input,
      reason: 'no-matching-rule',
      suggestedRules: [],
      pathLocation: classifyPath(target, req.projectPath),
    },
  };
}

/** A read the chat's own rules allow inside a linked folder, as written or resolved: the linked
 * project's own rules still decide, as they do for a read the chat's rules ask about. They are
 * another project's rules, checked after every rule of the chat's whatever those decided. It never
 * allows anything the chat's rules did not. */
function underLinkedRules(
  allowed: PermissionResult,
  req: PermissionRequest,
  docs: ScopedDocs,
): PermissionResult {
  const target = readTarget(req.tool, (req.input ?? {}) as ReadInput, req.projectPath);
  if (!target) return allowed;
  const holding = linkedRoots(req).filter((root) => within(target, root.path));
  if (holding.length === 0) return allowed;
  const realTarget = resolveToRealPath(target);
  const holders = holding.map((root) => ({ root, rels: relPaths(root.path, target, realTarget) }));
  const judged = judge(askFor(req, target), req, docs, holders, [target, realTarget]);
  return judged.decision === 'allow' ? allowed : judged;
}

/** True when a linked project's rules have a say over a search of its whole folder: they could not
 * be loaded, a Read deny or ask rule names files in it, or a rule denies or asks for the tool. */
function guardsFolder({ doc }: LinkedRoot, req: PermissionRequest): boolean {
  if (!doc) return true;
  const { kind } = evalScope(doc, req.tool, req.input, { resolvedPath: '' });
  return SEVERITY[kind] > 0 || ruleReachesInside(doc, '');
}

/** A search, or a Read of a folder, of a folder holding a linked folder (such as the folder both
 * projects sit in) reads that project's files too. When its rules have a say there, anything but a
 * deny asks with only "Allow once": a lasting rule would be the chat's own and step around them. */
function overLinkedFolders(decided: PermissionResult, req: PermissionRequest): PermissionResult {
  if (decided.decision === 'deny') return decided;
  const target = readTarget(req.tool, (req.input ?? {}) as ReadInput, req.projectPath);
  if (!target || !readsFolder(req.tool, resolveToRealPath(target))) return decided;
  const below = linkedRoots(req).filter(
    (root) => within(root.path, target) && !within(target, root.path),
  );
  if (!below.some((root) => guardsFolder(root, req))) return decided;
  return once(decided.decision === 'ask' ? decided : askFor(req, target));
}

/**
 * Allows a Read, Glob or Grep the checker would ask about when it reads only inside a linked
 * folder. Changes nothing unless the checker named no rule (`no-matching-rule`, which includes
 * the project tool-wide grant set aside outside the project), the target's real path is inside a
 * linked folder that is still not home or a drive, and a search neither climbs out nor spans a
 * protected folder. A path in a linked folder that leads to the deny list is denied, and so is a
 * Grep whose file filter names a file on it. The chat's own rules, matched again at the real path,
 * and the linked project's own rules then decide: a search asks when a Read deny or ask rule of
 * either can match a file inside it. A linked project whose rules could not be loaded grants
 * nothing. Where those rules let a read through, env files, read or given to a Grep by name, and
 * search filters that can reach one still ask, as in the chat's own folder, and so does a Grep
 * filtered by file type. The rules also run on a read the chat's own rules allow
 * (`underLinkedRules`), so no allow of the chat's steps around them. A search of a folder that
 * holds a linked folder meets the linked project's own rules (`overLinkedFolders`); no link grants
 * that search, so the chat's own rules decide it as before.
 */
export function applyLinkedRead(
  result: PermissionResult,
  req: PermissionRequest,
  docs: ScopedDocs,
): PermissionResult {
  if (!LINKED_READ_TOOLS.has(req.tool)) return result;
  const decided =
    result.decision === 'allow' ? underLinkedRules(result, req, docs) : fromAsk(result, req, docs);
  return overLinkedFolders(decided, req);
}

/** The linked-read answer for a read the chat's own rules ask or deny about. */
function fromAsk(
  result: PermissionResult,
  req: PermissionRequest,
  docs: ScopedDocs,
): PermissionResult {
  if (result.decision !== 'ask' || result.prompt.reason !== 'no-matching-rule') return result;
  const input = (req.input ?? {}) as ReadInput;
  const target = readTarget(req.tool, input, req.projectPath);
  if (!target) return result;
  const linked = linkedRoots(req);
  const holding = linked.filter((root) => isPathWithinProject(target, root.path));
  if (holding.length === 0 && !linked.some((root) => writtenWithin(target, root.path))) {
    return result;
  }
  const realTarget = resolveToRealPath(target);
  // Refused outright, so Auto review never weighs a read the deny list forbids.
  if (isSystemDeniedPath(target) || isSystemDeniedPath(realTarget)) {
    return { decision: 'deny', reason: { kind: 'safety:path', path: realTarget } };
  }
  // A link checked when it was made may since lead to home or a whole drive.
  if (holding.length === 0 || holding.some((root) => isRootFolder(root.path))) return result;
  if (!searchStaysInRoot(req.tool, input, target)) return result;
  const holders = holding.map((root) => ({ root, rels: relPaths(root.path, target, realTarget) }));
  const filtered = req.tool === 'Grep' ? grepFilterResult(input, target, result) : undefined;
  if (filtered?.decision === 'deny') return filtered;
  // The rules decide first: an env file, or a filter that can reach one, only turns a read they let
  // through into an ask, so a rule that denies or asks still does.
  const judged = judge(result, req, docs, holders, [target, realTarget]);
  if (judged.decision !== 'allow') return judged;
  if (opensTarget(req.tool, realTarget) && readsEnvFile(holders, target)) return result;
  return filtered ?? judged;
}
