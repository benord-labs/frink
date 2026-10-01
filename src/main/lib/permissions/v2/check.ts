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

import log from 'electron-log';
import { isFrinkMutatingFlowTool, isFrinkOwnedMcpTool } from '../../../../shared/lib/mcp-tool-name';
import { PATH_TOOLS } from '../../../../shared/types/permissions';
import { checkBash } from './check-bash';
import { checkEdit, type FileOpInput, type PathToolName } from './check-edit';
import { checkMcp } from './check-mcp';
import {
  combineScopes,
  EMPTY_DOCS,
  evalScope,
  resultFromCombined,
  type ScopedDocs,
} from './eval-rules';
import type { PermissionRequest, PermissionResult } from './types';

/**
 * Read-only search tools that today's `tool-validation.ts:60-63` auto-allows.
 * Mirroring here so ticket 09 wiring doesn't regress UX.
 */
const AUTO_ALLOW_TOOLS = new Set<string>(['Glob', 'Grep']);

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
    return checkEdit(
      req.input as FileOpInput,
      docs,
      req.projectPath,
      req.tool as PathToolName,
      req.sessionDirRoot,
      req.planDirRoot,
    );
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

  if (AUTO_ALLOW_TOOLS.has(req.tool)) {
    return { decision: 'allow' };
  }

  // Generic: rules-only, no tier-1c.
  const policy = evalScope(docs.policy, req.tool, req.input);
  const project = evalScope(docs.project, req.tool, req.input);
  const user = evalScope(docs.user, req.tool, req.input);
  return resultFromCombined(combineScopes(policy, project, user), req.tool, req.input);
}
