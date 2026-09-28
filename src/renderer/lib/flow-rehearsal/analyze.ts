/**
 * Static pre-flight analysis for Ghost Run (Rehearse) — Phase 1.
 *
 * Produces a deterministic, explainable list of findings about a flow graph. Every finding is a
 * pure function of node CONFIG + graph TOPOLOGY, so two identical nodes always yield identical
 * findings (no node-id hashing, no Math.random, no Date.now). A clean flow returns zero findings.
 *
 * Grounded in real, inspectable fields only — each rule mirrors a check the run-time validator
 * (`validateGraph`, mode 'run') or the template analyzer (`validateFlowTemplateVariables`) already
 * performs, restated here with per-node attribution + a plain-English why + a concrete fix so the
 * user can act without guessing.
 *
 * PHASE 2 seam (wired in `rehearseFlow`, ./index.ts): a real agent-understudy simulation would run
 * a model over each node and APPEND probabilistic findings (e.g. "this prompt will likely loop"). It
 * augments — never replaces — these static findings, so the deterministic floor is preserved.
 */

import {
  isCustomNodeBlockType,
  isRegisteredBlockType,
  isTriggerBlockType,
} from '../../../shared/lib/block-registry';
import { chatReplyTemplateWarnings } from '../../../shared/lib/flows/chat-reply-contract';
import {
  type CustomNodeInputsByType,
  findMissingRequiredCustomNodeInputs,
  type JsonValue,
} from '../../../shared/lib/flows/custom-node-required-inputs';
import { HTTP_REQUEST_MAX_URL_LENGTH } from '../../../shared/lib/http-request-limits';
import {
  type FlowGraph,
  type FlowNode,
  formatFlowNodeLabel,
} from '../../../shared/lib/validate-flow-graph';
import { validateFlowTemplateVariables } from '../../../shared/lib/validate-flow-templates';

/** Severity of a single rehearsal finding. `error` blocks a successful run; `warn`/`info` are advisory. */
export type FindingSeverity = 'error' | 'warn' | 'info';

/**
 * One explainable problem found by the static analysis. Carries enough context for the UI to render
 * a self-contained row (node label + why + fix) and to focus the offending node on click.
 */
export type RehearsalFinding = {
  /** The node this finding is attached to (used to focus/scroll the canvas). */
  nodeId: string;
  /** Display label of the node (custom label, registered default, else raw type). */
  nodeLabel: string;
  severity: FindingSeverity;
  /** Stable machine id for the rule that fired (also used as a React key alongside nodeId). */
  rule: string;
  /** Plain-English explanation of what is wrong. */
  why: string;
  /** Concrete next step the user can take to resolve it. */
  fix: string;
};

/** Rank for choosing the single highest-severity finding (the at-risk node). Higher wins. */
const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 2, warn: 1, info: 0 };

function configOf(node: FlowNode): Record<string, unknown> {
  const c = node.config;
  return c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

function isBlankString(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** True when any upstream node (transitively) has one of `blockTypes`. Cycle-safe via `visited`. */
function hasUpstreamBlockType(
  node: FlowNode,
  predecessorsOf: Map<string, string[]>,
  nodeById: Map<string, FlowNode>,
  blockTypes: ReadonlySet<string>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(node.id)) return false;
  visited.add(node.id);
  for (const predId of predecessorsOf.get(node.id) ?? []) {
    const pred = nodeById.get(predId);
    if (!pred) continue;
    if (blockTypes.has(pred.blockType)) return true;
    if (hasUpstreamBlockType(pred, predecessorsOf, nodeById, blockTypes, visited)) return true;
  }
  return false;
}

/** An `agent` needs an upstream task session — created by a `start_task` or another `agent`. */
const TASK_CREATOR_TYPES: ReadonlySet<string> = new Set(['start_task', 'agent']);
/** A `chat_reply` needs a chat session — from an upstream `start_task` or a `post_task_trigger`. */
const CHAT_SESSION_TYPES: ReadonlySet<string> = new Set(['start_task', 'post_task_trigger']);
/** The working-directory options the run-time validator accepts. */
const VALID_WORKING_DIRS: ReadonlySet<string> = new Set([
  'project_root',
  'trigger_worktree',
  'custom',
]);

type NodeFinding = Omit<RehearsalFinding, 'nodeId' | 'nodeLabel'>;
type NodeRuleCtx = {
  outgoingHandles: Map<string, Set<string>>;
  outgoingCount: Map<string, number>;
  predecessorsOf: Map<string, string[]>;
  nodeById: Map<string, FlowNode>;
  /** Declared inputs per installed custom node, keyed by block type. Absent while unknown. */
  customNodeInputs?: CustomNodeInputsByType;
};
type Cfg = Record<string, unknown>;

function runCommandFindings(c: Cfg): NodeFinding[] {
  const out: NodeFinding[] = [];
  if (isBlankString(c.command)) {
    out.push({
      severity: 'error',
      rule: 'run_command.missing_command',
      why: 'This Run Command step has no command set, so there is nothing to execute.',
      fix: 'Open the step and enter the shell command to run.',
    });
  }
  if (c.workingDirectory === 'custom' && isBlankString(c.customPath)) {
    out.push({
      severity: 'error',
      rule: 'run_command.missing_custom_path',
      why: 'Working directory is set to a custom path but no path was provided.',
      fix: 'Enter a custom path, or switch the working directory back to the project root.',
    });
  }
  if (typeof c.workingDirectory === 'string' && !VALID_WORKING_DIRS.has(c.workingDirectory)) {
    out.push({
      severity: 'error',
      rule: 'run_command.invalid_working_directory',
      why: `"${c.workingDirectory}" is not a valid working-directory option, so the flow cannot run.`,
      fix: 'Set the working directory to the project root, the trigger worktree, or a custom path.',
    });
  }
  return out;
}

/**
 * Shared shape for `agent` and `chat_reply`: a required text field must be filled, and the node
 * must sit downstream of something that opens a session. Params differ; the logic is one place.
 */
function sessionNodeFindings(
  c: Cfg,
  ctx: NodeRuleCtx,
  node: FlowNode,
  textField: string,
  blankFinding: NodeFinding,
  sessionTypes: ReadonlySet<string>,
  noSessionFinding: NodeFinding,
): NodeFinding[] {
  const out: NodeFinding[] = [];
  if (isBlankString(c[textField])) out.push(blankFinding);
  if (!hasUpstreamBlockType(node, ctx.predecessorsOf, ctx.nodeById, sessionTypes)) {
    out.push(noSessionFinding);
  }
  return out;
}

function chatReplyFindings(c: Cfg, ctx: NodeRuleCtx, node: FlowNode): NodeFinding[] {
  const out: NodeFinding[] = [];
  if (chatReplyTemplateWarnings(c).length > 0) {
    out.push({
      severity: 'warn',
      rule: 'chat_reply.empty_message',
      why:
        c.contentType === 'html_artifact'
          ? 'This Chat Reply needs both an artifact title and body HTML template.'
          : 'This Chat Reply has no message template, so an empty message would be posted.',
      fix:
        c.contentType === 'html_artifact'
          ? 'Open the step and add the artifact title and body HTML.'
          : 'Open the step and write the message to send back into the chat.',
    });
  }
  if (!hasUpstreamBlockType(node, ctx.predecessorsOf, ctx.nodeById, CHAT_SESSION_TYPES)) {
    out.push({
      severity: 'error',
      rule: 'chat_reply.no_chat_session',
      why: 'This Chat Reply has no upstream Start Task or Post-Task trigger, so there is no chat session to reply into.',
      fix: 'Add a Start Task step before it, or start the flow from a Post-Task trigger.',
    });
  }
  return out;
}

function httpRequestFindings(c: Cfg): NodeFinding[] {
  if (isBlankString(c.url)) {
    return [
      {
        severity: 'error',
        rule: 'http_request.missing_url',
        why: 'This HTTP Request step has no URL, so there is no endpoint to call.',
        fix: 'Open the step and set the request URL (http or https).',
      },
    ];
  }
  if (typeof c.url !== 'string') return [];
  if (c.url.length > HTTP_REQUEST_MAX_URL_LENGTH) {
    return [
      {
        severity: 'error',
        rule: 'http_request.url_too_long',
        why: `This URL is longer than the ${HTTP_REQUEST_MAX_URL_LENGTH}-character maximum, so the request will be rejected.`,
        fix: 'Shorten the URL.',
      },
    ];
  }
  try {
    const parsed = new URL(c.url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return [];
    return [
      {
        severity: 'error',
        rule: 'http_request.invalid_protocol',
        why: `"${c.url}" does not use http or https, so the request cannot be made.`,
        fix: 'Use a full http:// or https:// URL.',
      },
    ];
  } catch {
    return [
      {
        severity: 'error',
        rule: 'http_request.invalid_url',
        why: `"${c.url}" is not a valid URL, so there is no endpoint to call.`,
        fix: 'Enter a valid http:// or https:// URL.',
      },
    ];
  }
}

function webhookTriggerFindings(c: Cfg): NodeFinding[] {
  const out: NodeFinding[] = [];
  if (isBlankString(c.integrationId)) {
    out.push({
      severity: 'error',
      rule: 'webhook_trigger.missing_integration',
      why: 'This Webhook Trigger has no integration selected, so it can never fire.',
      fix: 'Open the trigger and connect/select the integration that should start this flow.',
    });
  }
  if (isBlankString(c.eventType)) {
    out.push({
      severity: 'error',
      rule: 'webhook_trigger.missing_event',
      why: 'This Webhook Trigger has no event type selected, so it has no signal to listen for.',
      fix: 'Open the trigger and pick the event type that should start this flow.',
    });
  }
  return out;
}

function conditionFindings(ctx: NodeRuleCtx, node: FlowNode): NodeFinding[] {
  const out: NodeFinding[] = [];
  const handles = ctx.outgoingHandles.get(node.id) ?? new Set<string>();
  if ((ctx.outgoingCount.get(node.id) ?? 0) !== 2) {
    out.push({
      severity: 'error',
      rule: 'condition.wrong_edge_count',
      why: 'A Condition must have exactly two outgoing edges — one for true and one for false.',
      fix: 'Wire exactly two connections out of this step: one from the true handle and one from the false handle.',
    });
  }
  if (!handles.has('true')) {
    out.push({
      severity: 'error',
      rule: 'condition.missing_true_branch',
      why: 'This Condition has no "true" branch, so a true result has nowhere to go.',
      fix: 'Drag a connection from the true (green) handle to the next step.',
    });
  }
  if (!handles.has('false')) {
    out.push({
      severity: 'error',
      rule: 'condition.missing_false_branch',
      why: 'This Condition has no "false" branch, so a false result has nowhere to go.',
      fix: 'Drag a connection from the false (red) handle to the next step.',
    });
  }
  return out;
}

/** Per-block-type config checks, each mirroring a run-time validator rule. Keyed by blockType. */
const BLOCK_RULES = new Map<string, (c: Cfg, ctx: NodeRuleCtx, node: FlowNode) => NodeFinding[]>([
  ['run_command', (c) => runCommandFindings(c)],
  [
    'agent',
    (c, ctx, node) =>
      sessionNodeFindings(
        c,
        ctx,
        node,
        'instructions',
        {
          severity: 'error',
          rule: 'agent.empty_prompt',
          why: 'This Agent step has no instructions, so the agent has no task to perform.',
          fix: 'Open the step and write the instructions for the agent.',
        },
        TASK_CREATOR_TYPES,
        {
          severity: 'error',
          rule: 'agent.no_task_creator',
          why: 'This Agent step has no upstream Start Task or Agent, so there is no task session to run in.',
          fix: 'Add a Start Task step before this agent (or chain it after another Agent).',
        },
      ),
  ],
  ['http_request', (c) => httpRequestFindings(c)],
  ['webhook_trigger', (c) => webhookTriggerFindings(c)],
  ['condition', (_c, ctx, node) => conditionFindings(ctx, node)],
  ['chat_reply', (c, ctx, node) => chatReplyFindings(c, ctx, node)],
]);

/** Per-node config checks: block-type rule + the cross-cutting custom/unknown-type checks. */
function analyzeNodeConfig(node: FlowNode, ctx: NodeRuleCtx): NodeFinding[] {
  const c = configOf(node);
  const out = BLOCK_RULES.get(node.blockType)?.(c, ctx, node) ?? [];

  // Declared-required custom-node inputs left unset. Skipped entirely when the manifest is not
  // known (uninstalled node, or the manifest query has not resolved) — NodeHealthBadge owns that
  // case, and guessing here would paint healthy nodes red.
  const manifestInputs = ctx.customNodeInputs?.get(node.blockType);
  if (manifestInputs) {
    // SAFETY: a persisted node config is plain JSON — it round-trips through graph storage.
    const missing = findMissingRequiredCustomNodeInputs(
      manifestInputs,
      c as Record<string, JsonValue>,
    );
    if (missing.length > 0) {
      const names = missing.map((k) => `"${k}"`).join(', ');
      out.push({
        severity: 'error',
        rule: 'custom_node.missing_required_input',
        why: `This custom node requires ${missing.length === 1 ? 'an input' : 'inputs'} it has no value for: ${names}.`,
        fix: 'Open the step and set the highlighted input(s), or give them a default in the node manifest.',
      });
    }
  }

  // Unknown block type — the run-time validator would reject this graph outright.
  if (!isRegisteredBlockType(node.blockType) && !isCustomNodeBlockType(node.blockType)) {
    out.push({
      severity: 'error',
      rule: 'node.unknown_block_type',
      why: `"${node.blockType}" is not a recognised block type, so the flow cannot run.`,
      fix: 'Replace this step with a supported block type.',
    });
  }

  return out;
}

/**
 * Run the full static analysis over a flow graph. Pure: same graph in → same findings out, ordered
 * deterministically (topology-independent, sorted by nodeId then rule).
 */
type GraphIndex = {
  outgoingHandles: Map<string, Set<string>>;
  outgoingCount: Map<string, number>;
  predecessorsOf: Map<string, string[]>;
};

/** One pass over the edges → the outgoing-handle/edge-count + predecessor maps the rules need. */
function buildGraphIndex(edges: FlowGraph['edges']): GraphIndex {
  const outgoingHandles = new Map<string, Set<string>>();
  const outgoingCount = new Map<string, number>();
  const predecessorsOf = new Map<string, string[]>();
  for (const e of edges) {
    const handles = outgoingHandles.get(e.source) ?? new Set<string>();
    if (typeof e.sourceHandle === 'string') handles.add(e.sourceHandle);
    outgoingHandles.set(e.source, handles);
    outgoingCount.set(e.source, (outgoingCount.get(e.source) ?? 0) + 1);
    const preds = predecessorsOf.get(e.target) ?? [];
    preds.push(e.source);
    predecessorsOf.set(e.target, preds);
  }
  return { outgoingHandles, outgoingCount, predecessorsOf };
}

/**
 * Unresolvable {{variable}} references — reuse the design-time template analyzer (grounded in the
 * real per-node output/trigger schemas) rather than re-deriving variable scope here.
 */
function templateFindings(graph: FlowGraph, nodeById: Map<string, FlowNode>): RehearsalFinding[] {
  const out: RehearsalFinding[] = [];
  for (const w of validateFlowTemplateVariables(graph)) {
    const node = nodeById.get(w.nodeId);
    if (!node) continue;
    if (w.shellHazard === 'blank-path') {
      out.push({
        nodeId: node.id,
        nodeLabel: formatFlowNodeLabel(node),
        severity: 'warn',
        rule: `template.${w.field}.${w.placeholder}.shell-blank-path`,
        why: w.message,
        fix: `Assign ${w.placeholder} to a shell variable and reference it as \${var:?} so a blank value stops the command.`,
      });
      continue;
    }
    const isShellQuoteWarning = w.field === 'command' && w.shellQuoteContext !== undefined;
    out.push({
      nodeId: node.id,
      nodeLabel: formatFlowNodeLabel(node),
      severity: 'warn',
      // Placeholder is part of the rule id so two bad references in one field stay distinct.
      rule: `template.${w.field}.${w.placeholder}${isShellQuoteWarning ? `.shell-quote.${w.shellQuoteContext}` : ''}`,
      why: w.message,
      fix: isShellQuoteWarning
        ? `Leave ${w.placeholder} bare and quote only the static text around it.`
        : `Reference a variable that an upstream step actually produces, or remove ${w.placeholder}.`,
    });
  }
  return out;
}

export function analyzeFlow(
  graph: FlowGraph,
  customNodeInputs?: CustomNodeInputsByType,
): RehearsalFinding[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const index = buildGraphIndex(graph.edges);

  const findings: RehearsalFinding[] = [];
  for (const node of graph.nodes) {
    const nodeFindings = analyzeNodeConfig(node, { ...index, nodeById, customNodeInputs });
    // Unreachable: a non-trigger node with no incoming edge can never run.
    if (
      !isTriggerBlockType(node.blockType) &&
      (index.predecessorsOf.get(node.id) ?? []).length === 0
    ) {
      nodeFindings.push({
        severity: 'warn',
        rule: 'node.unreachable',
        why: 'This step has no incoming connection, so the flow will never reach it.',
        fix: 'Connect an earlier step to this one, or remove it.',
      });
    }
    const label = formatFlowNodeLabel(node);
    for (const f of nodeFindings) findings.push({ nodeId: node.id, nodeLabel: label, ...f });
  }
  findings.push(...templateFindings(graph, nodeById));

  return findings.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.rule.localeCompare(b.rule));
}

/** Highest-severity finding's node id — the single at-risk (crimson) node. Deterministic. */
export function riskiestNodeId(findings: RehearsalFinding[]): string | null {
  let best: RehearsalFinding | null = null;
  for (const f of findings) {
    if (
      best === null ||
      SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity] ||
      (SEVERITY_RANK[f.severity] === SEVERITY_RANK[best.severity] && f.nodeId < best.nodeId)
    ) {
      best = f;
    }
  }
  return best?.nodeId ?? null;
}

/** Highest severity present across the findings for one node (for the node's ghost paint). */
export function nodeSeverity(findings: RehearsalFinding[]): FindingSeverity | null {
  let best: FindingSeverity | null = null;
  for (const f of findings) {
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  }
  return best;
}
