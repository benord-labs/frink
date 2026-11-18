/**
 * Central permission dispatcher. Single entry point used by every tool call
 * (post ticket-09 wiring). Branches on tool name; per-tool checkers are pure.
 *
 * Storage / scope-resolver wiring is deferred to ticket 07 — `loadDocs` is a
 * stub here that returns empty docs. The dispatcher exposes `setDocsLoader`
 * so ticket 07 can swap the implementation without touching this file.
 *
 * Ticket 05 of the permissions overhaul.
 */

import * as nodePath from 'node:path';
import log from 'electron-log';
import { isFrinkMutatingFlowTool, isFrinkOwnedMcpTool } from '../../../../shared/lib/mcp-tool-name';
import { PATH_TOOLS } from '../../../../shared/types/permissions';
import { checkBash } from './check-bash';
import { checkEdit, expandTilde, type FileOpInput, type PathToolName } from './check-edit';
import { checkMcp } from './check-mcp';
import {
  combineScopes,
  EMPTY_DOCS,
  evalScope,
  resultFromCombined,
  type ScopedDocs,
} from './eval-rules';
import { applyLinkedRead } from './linked-read';
import { checkSearch, type SearchInput } from './search';
import type { PermissionRequest, PermissionResult } from './types';

export type DocsLoader = (req: PermissionRequest) => Promise<ScopedDocs>;

const DEFAULT_LOADER: DocsLoader = async () => EMPTY_DOCS;

let activeLoader: DocsLoader = DEFAULT_LOADER;

/** Ticket 07 calls this with the real scope resolver. */
export function setDocsLoader(loader: DocsLoader): void {
  activeLoader = loader;
}

/** Reset to the empty-docs stub (test cleanup helper). */
export function resetDocsLoader(): void {
  activeLoader = DEFAULT_LOADER;
}

/** A file-op checker's answer, then a linked project's for a Read. */
function checkPathTool(req: PermissionRequest, docs: ScopedDocs): PermissionResult {
  const result = checkEdit(
    req.input as FileOpInput,
    docs,
    req.projectPath,
    req.tool as PathToolName,
    req.sessionDirRoot,
    req.planDirRoot,
  );
  // Linked projects grant reads only, after every rule above has had its say.
  return req.tool === 'Read' && req.linkedRoots?.length
    ? applyLinkedRead(result, req, docs)
    : result;
}

/** The Read of the files a search filter names, for the Read question of a Copilot or Cursor
 * search outside the chat's folder, which carries the filter as `glob` beside the folder. */
function filterRead(req: PermissionRequest): PermissionRequest | undefined {
  if (req.tool !== 'Read') return undefined;
  const { file_path: folder, glob } = (req.input ?? {}) as { file_path?: unknown; glob?: unknown };
  if (typeof folder !== 'string' || !folder || typeof glob !== 'string') return undefined;
  const file_path = nodePath.resolve(req.projectPath, expandTilde(folder), glob);
  return { ...req, input: { file_path } };
}

/** How strict an answer is: a deny, then an ask that names its rule, then any ask, then allow. */
function strictness(result: PermissionResult): number {
  if (result.decision === 'allow') return 0;
  if (result.decision === 'deny') return 3;
  return result.prompt.reason === 'no-matching-rule' ? 1 : 2;
}

export async function checkPermission(req: PermissionRequest): Promise<PermissionResult> {
  // Rules that cannot be read cannot be honoured, so an unreadable store denies
  // instead of falling through to the no-rules prompt default.
  let docs: ScopedDocs;
  try {
    docs = await activeLoader(req);
  } catch (err) {
    log.error('[permissions] Could not load permission rules — denying', err);
    return { decision: 'deny', reason: { kind: 'db:unavailable' } };
  }

  if (req.tool === 'Bash') {
    return checkBash(req.input as { command: string }, docs, req.projectPath);
  }

  if (PATH_TOOLS.has(req.tool)) {
    const result = checkPathTool(req, docs);
    // A search filter is judged as a Read of the files it names, as the deny list and the rules
    // match paths, never a folder's filter. The stricter answer raises the search's one card.
    const filter = filterRead(req);
    if (!filter) return result;
    const filtered = checkPathTool(filter, docs);
    return strictness(filtered) > strictness(result) ? filtered : result;
  }

  if (req.tool.startsWith('mcp__')) {
    // Frink's own read/infra MCP tools are trusted — auto-allowed so the
    // permission card never shows. Mutating flow tools consult the normal
    // rule scopes like any other MCP tool (deny honored, ask → standard
    // prompt or Auto review).
    if (req.trustedFrinkOwnedMcp ?? isFrinkOwnedMcpTool(req.tool)) {
      if (isFrinkMutatingFlowTool(req.tool)) {
        return checkMcp(
          { toolName: req.tool, toolInput: req.input, mcpIdentity: req.mcpIdentity },
          docs,
        );
      }
      return { decision: 'allow' };
    }
    return checkMcp(
      { toolName: req.tool, toolInput: req.input, mcpIdentity: req.mcpIdentity },
      docs,
    );
  }

  if (req.tool === 'Glob' || req.tool === 'Grep') {
    const result = checkSearch(req.tool, req.input as SearchInput, docs, req.projectPath);
    return req.linkedRoots?.length ? applyLinkedRead(result, req, docs) : result;
  }

  // Generic: rules-only, no tier-1c.
  const policy = evalScope(docs.policy, req.tool, req.input);
  const project = evalScope(docs.project, req.tool, req.input);
  const user = evalScope(docs.user, req.tool, req.input);
  return resultFromCombined(combineScopes(policy, project, user), req.tool, req.input);
}
