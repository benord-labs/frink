/**
 * Display summaries and incomplete-config hints for flow nodes (editor).
 */

import { findPluginActionByNodeName } from '../../../../shared/integrations/plugin-nodes';
import { getPluginDefinition } from '../../../../shared/integrations/plugins';
import {
  isCustomNodeBlockType,
  isRegisteredBlockType,
} from '../../../../shared/lib/block-registry';
import type { FlowNode } from '../../../../shared/lib/validate-flow-graph';
import { FLOW_BLOCK_TYPES, type FlowBlockType } from '../../../../shared/types/flow';
import {
  classifyProjectRef,
  ID_ONLY_PROJECT_RULES,
  LITERAL_PROJECT_RULES,
  type NodeProjectProblem,
  nodeProjectProblem,
  type ProjectRef,
  type ProjectRefRules,
  STEP_PROJECT_RULES,
} from './BlockConfig/node-project-resolution';
import { FLOW_BLOCK_LABELS } from './constants';
import { truncateUiString } from './truncate-ui-string';

const VALUE_REQUIRED_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains']);

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Why this node's project (its own, else the flow default) won't resolve at run time, if it won't. */
function projectProblem(
  node: FlowNode,
  flowDefaultProjectId: string | undefined,
  ctx: FlowNodeCanvasContext | undefined,
): NodeProjectProblem | null {
  const own = typeof node.config?.projectId === 'string' ? node.config.projectId : '';
  const rules = isCustomNodeBlockType(node.blockType) ? ID_ONLY_PROJECT_RULES : STEP_PROJECT_RULES;
  return nodeProjectProblem(own, flowDefaultProjectId, ctx?.projects ?? null, rules);
}

function hasEffectiveProject(
  node: FlowNode,
  flowDefaultProjectId: string | undefined,
  ctx: FlowNodeCanvasContext | undefined,
): boolean {
  return projectProblem(node, flowDefaultProjectId, ctx) === null;
}

/** Summary copy for a project that is set but can't be found; null when missing or fine. */
function unresolvedProjectLine(
  node: FlowNode,
  flowDefaultProjectId: string | undefined,
  ctx: FlowNodeCanvasContext | undefined,
): string | null {
  const problem = projectProblem(node, flowDefaultProjectId, ctx);
  if (!problem || problem.state === 'missing') return null;
  const name = truncateUiString(problem.value, 40);
  if (problem.state === 'ambiguous') return `More than one project is named “${name}”`;
  if (problem.state === 'malformed') return `“${name}” isn't a valid variable`;
  return `Project “${name}” isn't on this computer`;
}

/** A post-task binding matches tasks by project id only; an empty one falls back and is allowed. */
function postTaskProjectGone(
  cfg: FlowNode['config'],
  ctx: FlowNodeCanvasContext | undefined,
): string | null {
  const id = readString(cfg, 'bindingProjectId');
  if (id === undefined) return null;
  return classifyProjectRef(id, ctx?.projects ?? null, ID_ONLY_PROJECT_RULES) === 'ok' ? null : id;
}

/** A webhook bound to an account that is no longer connected never fires. */
function webhookAccountGone(
  cfg: Record<string, unknown> | undefined,
  ctx: FlowNodeCanvasContext | undefined,
): boolean {
  const id = readString(cfg, 'integrationId');
  const connected = ctx?.connectedIntegrationIds;
  return id !== undefined && connected != null && !connected.has(id);
}

/**
 * Whether a project is part of this node's contract at all. Shared by
 * `flowNodeNeedsProject` and `flowNodeNeedsAttention` so the CTA link and the
 * warning dot cannot disagree about which nodes take one.
 *
 * Plugin steps are the exception inside the custom-node family: they dispatch
 * through their catalog action, which never reads projectId.
 */
function takesProject(node: FlowNode): boolean {
  if (findPluginActionByNodeName(node.blockType)) return false;
  const block = node.blockType as FlowBlockType;
  return (
    block === 'start_task' ||
    block === 'run_command' ||
    isCustomNodeBlockType(block) ||
    !FLOW_BLOCK_TYPES.includes(block)
  );
}

/** True when the flow default is the project in use and is missing or unknown: the canvas
 *  deep-links to flow settings. A bad project on the step itself is fixed in the step. */
export function flowNodeNeedsProject(
  node: FlowNode,
  flowDefaultProjectId?: string,
  ctx?: FlowNodeCanvasContext,
): boolean {
  return (
    takesProject(node) && projectProblem(node, flowDefaultProjectId, ctx)?.fromDefault === true
  );
}

/** How flow settings checks the default: by id only once a custom step inherits it, as the canvas does. */
export function flowDefaultProjectRules(nodes: readonly FlowNode[]): ProjectRefRules {
  const customInherits = nodes.some(
    (n) =>
      isCustomNodeBlockType(n.blockType) && takesProject(n) && !readString(n.config, 'projectId'),
  );
  return customInherits ? ID_ONLY_PROJECT_RULES : LITERAL_PROJECT_RULES;
}

/** A step's name and kind, as both the canvas card and the config panel title it. */
export type FlowStepIdentity = { name: string; kind: string };

export function flowStepIdentity(node: FlowNode): FlowStepIdentity {
  // A plugin step's kind IS its provider: "Slack", never the internal `slack_send_message`.
  const pluginStep = findPluginActionByNodeName(node.blockType);
  const kind = pluginStep
    ? (getPluginDefinition(pluginStep.pluginId)?.name ?? pluginStep.pluginId)
    : isRegisteredBlockType(node.blockType)
      ? FLOW_BLOCK_LABELS[node.blockType]
      : node.blockType;
  // Unlabelled plugin steps arrive from every author but the node picker (patch tool, templates).
  return { name: node.label?.trim() || pluginStep?.action.label || kind, kind };
}

export type FlowNodeCanvasContext = {
  /** Cloud catalog descriptions keyed by custom block type name. */
  customDescriptionByBlockType?: ReadonlyMap<string, string>;
  /**
   * When a non-null Set, custom block types not in this set need attention (not in cloud catalog).
   * When `null`/`undefined`, skip catalog checks (e.g. list still loading or unavailable).
   */
  customCatalogNames?: ReadonlySet<string> | null;
  /** Projects on this computer; `null`/`undefined` skips the unknown-project check. */
  projects?: readonly ProjectRef[] | null;
  /** Connected account ids; `null`/`undefined` skips the disconnected-webhook check. */
  connectedIntegrationIds?: ReadonlySet<string> | null;
};

export function flowNodeSummaryLine(
  node: FlowNode,
  flowDefaultProjectId?: string,
  ctx?: FlowNodeCanvasContext,
): string {
  const cfg = node.config;
  const block = node.blockType as FlowBlockType;

  switch (block) {
    // The card shows the step's name right above this line, so triggers say what starts them.
    case 'manual_trigger':
      return 'Runs when you press Run';
    case 'webhook_trigger': {
      if (webhookAccountGone(cfg, ctx)) return "Account isn't connected";
      const et = readString(cfg, 'eventType');
      return et ? `On ${et}` : 'Choose an event';
    }
    case 'post_task_trigger': {
      const gone = postTaskProjectGone(cfg, ctx);
      if (gone) return `Project “${truncateUiString(gone, 40)}” isn't on this computer`;
      const ts = cfg?.triggerStates;
      const n = Array.isArray(ts) ? ts.length : 0;
      return n > 0 ? `Watches ${n} task status${n === 1 ? '' : 'es'}` : 'Runs after a task';
    }
    case 'schedule_trigger': {
      const cron = readString(cfg, 'cronExpression');
      return cron ? `Runs on ${truncateUiString(cron, 40)}` : 'Set a schedule';
    }
    case 'start_task':
      if (hasEffectiveProject(node, flowDefaultProjectId, ctx)) {
        return 'Sets up the project, worktree and branch';
      }
      return unresolvedProjectLine(node, flowDefaultProjectId, ctx) ?? 'Set a project';
    case 'agent': {
      const inst = readString(cfg, 'instructions');
      if (inst) return truncateUiString(inst, 72);
      return 'Add instructions';
    }
    case 'run_command': {
      const unresolved = unresolvedProjectLine(node, flowDefaultProjectId, ctx);
      if (unresolved) return unresolved;
      const cmd = readString(cfg, 'command');
      if (cmd) return truncateUiString(cmd, 72);
      if (!hasEffectiveProject(node, flowDefaultProjectId, ctx)) return 'Add command and project';
      return 'Add command';
    }
    case 'http_request': {
      const u = readString(cfg, 'url');
      if (u) return truncateUiString(u, 72);
      return 'Add URL';
    }
    case 'condition': {
      const pred = cfg?.predicate;
      if (pred && typeof pred === 'object' && pred !== null && !Array.isArray(pred)) {
        const p = pred as Record<string, unknown>;
        const field = typeof p.field === 'string' ? p.field : '';
        const op = typeof p.operator === 'string' ? p.operator : '';
        if (field && op) {
          if (op === 'truthy') return `If ${field} is truthy`;
          if (op === 'falsy') return `If ${field} is falsy`;
          const v = p.value;
          const vs =
            v === undefined || v === null
              ? ''
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v);
          return vs ? `If ${field} ${op} ${truncateUiString(vs, 24)}` : `If ${field} ${op}`;
        }
      }
      return 'Configure condition';
    }
    case 'chat_reply': {
      if (cfg?.contentType === 'html_artifact') {
        const title = readString(cfg, 'artifactTitleTemplate');
        return title ? `Interactive: ${truncateUiString(title, 59)}` : 'Add artifact title';
      }
      const tpl = readString(cfg, 'messageTemplate');
      if (tpl) return truncateUiString(tpl, 72);
      return 'Add message template';
    }
    case 'fan_out': {
      const field = readString(cfg, 'arrayField') ?? 'items';
      const max = cfg?.maxIterations;
      const maxStr = typeof max === 'number' ? ` (max ${max})` : '';
      const mode = cfg?.mode === 'parallel' ? ' · parallel' : '';
      return `Iterate over ${field}${maxStr}${mode}`;
    }
    case 'approval': {
      const msg = readString(cfg, 'message');
      return msg ? truncateUiString(msg, 72) : 'Approval required';
    }
    case 'end':
      return 'Terminates this branch';
    default: {
      if (isCustomNodeBlockType(node.blockType)) {
        const unresolved = takesProject(node)
          ? unresolvedProjectLine(node, flowDefaultProjectId, ctx)
          : null;
        if (unresolved) return unresolved;
        const desc = ctx?.customDescriptionByBlockType?.get(node.blockType);
        if (desc && desc.trim().length > 0) {
          return truncateUiString(desc.trim(), 72);
        }
        // Catalog copy is synchronous, so a plugin step never falls through to the
        // raw node name, and never to a "set project" hint it does not take.
        const pluginStep = findPluginActionByNodeName(node.blockType);
        if (pluginStep) {
          return truncateUiString(pluginStep.action.description ?? pluginStep.action.label, 72);
        }
        const typeLabel = node.blockType;
        if (!hasEffectiveProject(node, flowDefaultProjectId, ctx)) {
          return `${typeLabel} · set project`;
        }
        return truncateUiString(typeLabel, 72);
      }
      return node.blockType;
    }
  }
}

export function flowNodeNeedsAttention(
  node: FlowNode,
  flowDefaultProjectId?: string,
  ctx?: FlowNodeCanvasContext,
): boolean {
  const cfg = node.config;
  const block = node.blockType as FlowBlockType;

  switch (block) {
    case 'start_task':
      return !hasEffectiveProject(node, flowDefaultProjectId, ctx);
    case 'agent':
      return !readString(cfg, 'instructions');
    case 'chat_reply':
      return cfg?.contentType === 'html_artifact'
        ? !readString(cfg, 'artifactTitleTemplate') || !readString(cfg, 'artifactBodyHtmlTemplate')
        : !readString(cfg, 'messageTemplate');
    case 'run_command':
      return !readString(cfg, 'command') || !hasEffectiveProject(node, flowDefaultProjectId, ctx);
    case 'http_request':
      return !readString(cfg, 'url');
    case 'condition': {
      const pred = cfg?.predicate;
      if (!pred || typeof pred !== 'object' || pred === null || Array.isArray(pred)) return true;
      const p = pred as Record<string, unknown>;
      const field = typeof p.field === 'string' ? p.field.trim() : '';
      const op = typeof p.operator === 'string' ? p.operator : '';
      if (!field || !op) return true;
      if (['truthy', 'falsy'].includes(op)) return false;
      if (VALUE_REQUIRED_OPS.has(op)) {
        const v = p.value;
        if (v === '' || v === undefined || v === null) return true;
        if (typeof v === 'number') return Number.isNaN(v);
        if (typeof v === 'string' && v.trim() === '') return true;
        return false;
      }
      return false;
    }
    case 'fan_out':
      return false;
    case 'end':
      return false;
    case 'webhook_trigger':
      return (
        !readString(cfg, 'integrationId') ||
        webhookAccountGone(cfg, ctx) ||
        !readString(cfg, 'eventType')
      );
    case 'schedule_trigger':
      return !readString(cfg, 'cronExpression');
    case 'post_task_trigger':
      return postTaskProjectGone(cfg, ctx) !== null;
    case 'manual_trigger':
      return false;
    default: {
      if (isCustomNodeBlockType(block)) {
        if (takesProject(node) && !hasEffectiveProject(node, flowDefaultProjectId, ctx))
          return true;
        if (ctx?.customCatalogNames != null && !ctx.customCatalogNames.has(node.blockType)) {
          return true;
        }
        return false;
      }
      return !hasEffectiveProject(node, flowDefaultProjectId, ctx);
    }
  }
}
