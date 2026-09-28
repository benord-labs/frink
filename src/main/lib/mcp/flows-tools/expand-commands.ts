/**
 * Author-time slash-command expansion for `frink_flows_patch`.
 *
 * When an agent node's `instructions` begin with a `/command`, resolve that
 * command's saved-prompt body (frink/cursor/claude, project + user-global) and
 * bake it into the node — the same representation the UI dropdown produces. This
 * runs in Electron main (filesystem access) before the flow version is saved, so
 * both local and cloud runtimes receive the real prompt rather than a literal
 * `/command` the spawned CLI cannot reliably expand cross-provider.
 *
 * Scope: one LEADING command per agent node (matches the shared expander). An
 * unknown command is a hard failure (the handler rejects the patch with
 * suggestions); see [[expand-slash-command]].
 */

import { BUILTIN_COMMAND_NAMES } from '../../../../shared/commands/builtin-command-names';
import {
  type CommandEntry,
  type CommandFetcher,
  expandSlashCommand,
  SLASH_COMMAND_REGEX,
} from '../../../../shared/commands/expand-slash-command';
import {
  describeAgentProseOverflow,
  findAgentProseOverflow,
} from '../../../../shared/lib/flows/agent-prose-limit';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';

export type CommandExpansionFailure = {
  nodeId: string;
  label: string;
  command: string;
  reason: 'not_found' | 'empty' | 'too_long';
  /** too_long only: the length-limit sentence (sc-3166). */
  detail?: string;
  suggestions: string[];
  available: string[];
};

export type ExpandResult =
  | { ok: true; expanded: { nodeId: string; command: string }[] }
  | { ok: false; failures: CommandExpansionFailure[] };

export type ExpandDeps = {
  /** Resolve a projectId to an absolute path, or null when unknown/path-less. */
  resolveProjectPath: (projectId: string) => Promise<string | null>;
  /** List command entries visible to a project scope (user-global + project). */
  listCommands: (projectPath: string | undefined) => Promise<CommandEntry[]>;
  /** Read a command body with frontmatter stripped. */
  getContent: (path: string) => Promise<string>;
  /** Flow-level fallback projectId (from getFlow / the create arg). */
  fallbackProjectId?: string;
  /**
   * When set, only these node ids are (re)expanded — the patch hook passes the
   * nodes whose `instructions` were set in this call. This keeps expansion an
   * authoring-time action: a previously-expanded body that happens to start with
   * a `/word` is never re-scanned on an unrelated patch (which would hard-fail and
   * leave the flow un-patchable). Omit to expand every agent node (used by tests).
   */
  targetNodeIds?: ReadonlySet<string>;
};

const BUILTIN_NAMES = new Set<string>(BUILTIN_COMMAND_NAMES);

/** Levenshtein edit distance. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_v, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Closest command names to `name`, within a forgiving threshold, nearest first. */
export function nearestCommands(name: string, names: string[], limit = 3): string[] {
  const threshold = Math.max(2, Math.floor(name.length * 0.3));
  return names
    .map((n) => ({ n, d: editDistance(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= threshold)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}

/**
 * Resolve the projectId an agent node will run under: the nearest upstream
 * `start_task`'s `config.projectId` (the runtime source of truth), else the
 * flow's `settings.defaultProjectId`, else the flow-level fallback.
 */
export function resolveNodeProjectId(
  graph: FlowGraph,
  nodeId: string,
  fallbackProjectId?: string,
): string | undefined {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = incoming.get(e.target);
    if (arr) arr.push(e.source);
    else incoming.set(e.target, [e.source]);
  }

  const visited = new Set<string>([nodeId]);
  let frontier = incoming.get(nodeId) ?? [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodeById.get(id);
      if (node?.blockType === 'start_task') {
        const pid = (node.config as { projectId?: unknown } | undefined)?.projectId;
        if (typeof pid === 'string' && pid.trim()) return pid.trim();
      }
      const preds = incoming.get(id);
      if (preds) next.push(...preds);
    }
    frontier = next;
  }

  const settingsPid = (graph.settings as { defaultProjectId?: unknown } | undefined)
    ?.defaultProjectId;
  if (typeof settingsPid === 'string' && settingsPid.trim()) return settingsPid.trim();
  return fallbackProjectId;
}

/**
 * Expand leading `/command` instructions on every agent node in `graph`, mutating
 * the node config in place. Returns `{ ok: false, failures }` if any referenced
 * command is unknown or empty — the caller hard-fails and persists nothing.
 */
export async function expandAgentCommandsInGraph(
  graph: FlowGraph,
  deps: ExpandDeps,
): Promise<ExpandResult> {
  // Memoize directory scans per resolved project path: a graph with several
  // command-referencing agent nodes under one project would otherwise trigger a
  // full filesystem scan per node (and again per failure).
  const listCache = new Map<string | undefined, Promise<CommandEntry[]>>();
  const listCommands = (projectPath: string | undefined): Promise<CommandEntry[]> => {
    const cached = listCache.get(projectPath);
    if (cached) return cached;
    const pending = deps.listCommands(projectPath);
    listCache.set(projectPath, pending);
    return pending;
  };

  const fetcher: CommandFetcher = { listCommands, getContent: deps.getContent };
  const failures: CommandExpansionFailure[] = [];
  const expanded: { nodeId: string; command: string }[] = [];
  const projectPathCache = new Map<string, string | undefined>();

  for (const node of graph.nodes) {
    if (node.blockType !== 'agent') continue;
    if (deps.targetNodeIds && !deps.targetNodeIds.has(node.id)) continue;
    const config = node.config as Record<string, unknown> | undefined;
    const instructions = typeof config?.instructions === 'string' ? config.instructions : '';
    const match = instructions.match(SLASH_COMMAND_REGEX);
    if (!match) continue;

    const command = match[1];
    // Built-ins are CLI directives, not saved prompts — leave them literal.
    if (BUILTIN_NAMES.has(command.toLowerCase())) continue;

    const projectId = resolveNodeProjectId(graph, node.id, deps.fallbackProjectId);
    let projectPath: string | undefined;
    if (projectId !== undefined) {
      if (projectPathCache.has(projectId)) {
        projectPath = projectPathCache.get(projectId);
      } else {
        projectPath = (await deps.resolveProjectPath(projectId)) ?? undefined;
        projectPathCache.set(projectId, projectPath);
      }
    }

    const result = await expandSlashCommand(instructions, projectPath, fetcher);

    if (result === instructions || result.trim() === '') {
      const available = (await listCommands(projectPath)).map((c) => c.name);
      failures.push({
        nodeId: node.id,
        label: node.label ?? node.id,
        command,
        reason: result === instructions ? 'not_found' : 'empty',
        suggestions: nearestCommands(command, available),
        available,
      });
      continue;
    }

    // The patch validated the short `/command`; the expanded body must fit the cap too (sc-3166).
    const overflow = findAgentProseOverflow({ instructions: result });
    if (overflow) {
      failures.push({
        nodeId: node.id,
        label: node.label ?? node.id,
        command,
        reason: 'too_long',
        detail: describeAgentProseOverflow(overflow.field, overflow.length),
        suggestions: [],
        available: [],
      });
      continue;
    }

    node.config = { ...config, instructions: result, instructionsCommandName: command };
    expanded.push({ nodeId: node.id, command });
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true, expanded };
}

/** Render expansion failures into an agent-actionable error message. */
export function formatExpansionFailures(failures: CommandExpansionFailure[]): string {
  const lines = failures.map((f) => {
    if (f.reason === 'too_long') {
      return `- node "${f.label}" (${f.nodeId}): command "/${f.command}" expands to ${f.detail} — shorten the command's prompt.`;
    }
    if (f.reason === 'empty') {
      return `- node "${f.label}" (${f.nodeId}): command "/${f.command}" resolves to an empty file.`;
    }
    const didYouMean =
      f.suggestions.length > 0 ? ` Did you mean: ${f.suggestions.join(', ')}?` : '';
    const available =
      f.available.length > 0
        ? ` Available: ${f.available.slice(0, 25).join(', ')}${f.available.length > 25 ? ', …' : ''}.`
        : ' No commands found for this project.';
    return `- node "${f.label}" (${f.nodeId}): command "/${f.command}" not found.${didYouMean}${available}`;
  });
  return [
    'Command expansion failed — flow not saved. Fix the agent instructions and retry with flowId:',
    ...lines,
    'A command must be the first token of the instructions. Call frink_flows_list_catalog({ kind: "commands" }) to see available commands.',
  ].join('\n');
}
