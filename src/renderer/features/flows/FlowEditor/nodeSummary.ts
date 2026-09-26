/**
 * Display summaries and incomplete-config hints for flow nodes (editor).
 */

import { findPluginActionByNodeName } from '../../../../shared/integrations/plugin-nodes';
import { isCustomNodeBlockType } from '../../../../shared/lib/block-registry';
import type { FlowNode } from '../../../../shared/lib/validate-flow-graph';
import { FLOW_BLOCK_TYPES, type FlowBlockType } from '../../../../shared/types/flow';
import { FLOW_BLOCK_LABELS } from './constants';
import { truncateUiString } from './truncate-ui-string';

const VALUE_REQUIRED_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains']);

function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Returns true when a project is resolved — either from the node itself or the flow default. */
function hasEffectiveProject(
  cfg: Record<string, unknown> | undefined,
  flowDefaultProjectId: string | undefined,
): boolean {
  const nodeProjectId = typeof cfg?.projectId === 'string' ? cfg.projectId.trim() : '';
  return nodeProjectId !== '' || (flowDefaultProjectId?.trim() ?? '') !== '';
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

/**
 * True when this node's attention state is (at least partly) a missing project — used by
 * the canvas to deep-link the warning to the flow settings Project field.
 */
export function flowNodeNeedsProject(node: FlowNode, flowDefaultProjectId?: string): boolean {
  return takesProject(node) && !hasEffectiveProject(node.config, flowDefaultProjectId);
}

export type FlowNodeCanvasContext = {
  /** Cloud catalog descriptions keyed by custom block type name. */
  customDescriptionByBlockType?: ReadonlyMap<string, string>;
  /**
   * When a non-null Set, custom block types not in this set need attention (not in cloud catalog).
   * When `null`/`undefined`, skip catalog checks (e.g. list still loading or unavailable).
   */
  customCatalogNames?: ReadonlySet<string> | null;
};

export function flowNodeSummaryLine(
  node: FlowNode,
  flowDefaultProjectId?: string,
  ctx?: FlowNodeCanvasContext,
): string {
  const cfg = node.config;
  const block = node.blockType as FlowBlockType;

  switch (block) {
    case 'manual_trigger': {
      const display = node.label?.trim() || FLOW_BLOCK_LABELS[block];
      return display;
    }
    case 'webhook_trigger': {
      const et = readString(cfg, 'eventType');
      const display = node.label?.trim() || FLOW_BLOCK_LABELS[block];
      return et ? `${display} · ${et}` : display;
    }
    case 'post_task_trigger': {
      const display = node.label?.trim() || FLOW_BLOCK_LABELS[block];
      const ts = cfg?.triggerStates;
      const n = Array.isArray(ts) ? ts.length : 0;
      return n > 0 ? `${display} · ${n} status(es)` : display;
    }
    case 'schedule_trigger': {
      const display = node.label?.trim() || FLOW_BLOCK_LABELS[block];
      const cron = readString(cfg, 'cronExpression');
      return cron ? `${display} · ${truncateUiString(cron, 40)}` : display;
    }
    case 'start_task': {
      const display = node.label?.trim() || FLOW_BLOCK_LABELS[block];
      if (!hasEffectiveProject(cfg, flowDefaultProjectId)) return `${display} · set project`;
      return display;
    }
    case 'agent': {
      const inst = readString(cfg, 'instructions');
      if (inst) return truncateUiString(inst, 72);
      return 'Add instructions';
    }
    case 'run_command': {
      const cmd = readString(cfg, 'command');
      if (cmd) return `Run: ${truncateUiString(cmd, 56)}`;
      if (!hasEffectiveProject(cfg, flowDefaultProjectId)) return 'Add command and project';
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
        if (!hasEffectiveProject(node.config, flowDefaultProjectId)) {
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
      return !hasEffectiveProject(cfg, flowDefaultProjectId);
    case 'agent':
      return !readString(cfg, 'instructions');
    case 'chat_reply':
      return cfg?.contentType === 'html_artifact'
        ? !readString(cfg, 'artifactTitleTemplate') || !readString(cfg, 'artifactBodyHtmlTemplate')
        : !readString(cfg, 'messageTemplate');
    case 'run_command':
      return !readString(cfg, 'command') || !hasEffectiveProject(cfg, flowDefaultProjectId);
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
      return !readString(cfg, 'integrationId') || !readString(cfg, 'eventType');
    case 'schedule_trigger':
      return !readString(cfg, 'cronExpression');
    case 'post_task_trigger':
      return false;
    default: {
      if (isCustomNodeBlockType(block)) {
        if (takesProject(node) && !hasEffectiveProject(cfg, flowDefaultProjectId)) return true;
        if (ctx?.customCatalogNames != null && !ctx.customCatalogNames.has(node.blockType)) {
          return true;
        }
        return false;
      }
      return !hasEffectiveProject(cfg, flowDefaultProjectId);
    }
  }
}
