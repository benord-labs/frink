/**
 * Classifies `{{path}}` placeholders for inline highlighting in template fields.
 * Aligns with `validate-flow-templates` semantics (previous / trigger / loop / flow roots).
 */

import { TEMPLATE_VARIABLE_PATTERN } from '../../../../../../shared/lib/template-constants';
import type { NodeVariables } from '../../../../../../shared/lib/validate-flow-templates';

export type TemplateVarTone = 'valid' | 'dynamic' | 'undeclared';

type ClassifyTemplatePathOptions = {
  /** True while `trpc.customNodes.list` is still loading (avoid flashing red for custom predecessors). */
  customNodesLoading?: boolean;
  /** True when the immediate predecessor block is a custom node (manifest-driven schema). */
  predecessorIsCustomNode?: boolean;
};

export function classifyTemplatePath(
  fullPath: string,
  vars: NodeVariables | null | undefined,
  options: ClassifyTemplatePathOptions = {},
): TemplateVarTone {
  const path = fullPath.trim();
  if (!path) return 'undeclared';

  const segments = path.split('.').filter(Boolean);
  const root = segments[0];
  if (!root) return 'undeclared';

  const { customNodesLoading = false, predecessorIsCustomNode = false } = options;

  if (!vars) {
    if (predecessorIsCustomNode && customNodesLoading && root === 'previous') return 'dynamic';
    return 'undeclared';
  }

  if (root === 'trigger') {
    const rest = segments.slice(1).join('.');
    if (!rest) return 'undeclared';
    // Exact match — a friendly alias (e.g. story.title) or a scalar/object top-level
    // field (event, payload, triggeredBy).
    if (vars.trigger.some((t) => t.key === rest)) return 'valid';
    const seg1 = segments[1];
    const top = vars.trigger.find((t) => t.key === seg1);
    if (top) {
      // Deeper path into a known top-level field. An open-ended object (payload = the
      // raw provider webhook body) can't be verified at design time → dynamic; a
      // structured object (e.g. triggeredBy.externalUserId) is valid.
      return top.openEnded ? 'dynamic' : 'valid';
    }
    // Undeclared but trigger accepts arbitrary keys at runtime (e.g. manual_trigger batch flows).
    if (vars.allowsArbitraryTriggerKeys) return 'dynamic';
    return 'undeclared';
  }

  if (root === 'previous') {
    const key = segments[1];
    if (!key) return 'undeclared';
    const matched = vars.previous.find((f) => f.key === key);
    if (matched) return 'valid';
    const isDynamic = vars.notes.some((n) => n.includes('dynamic'));
    if (isDynamic) return 'dynamic';
    if (predecessorIsCustomNode && customNodesLoading) return 'dynamic';
    return 'undeclared';
  }

  if (root === 'loop') {
    const key = segments[1];
    if (!key || !vars.loop) return 'undeclared';
    return vars.loop.some((f) => f.key === key) ? 'valid' : 'undeclared';
  }

  if (root === 'flow') {
    const key = segments[1];
    if (!key || !vars.flow) return 'undeclared';
    return vars.flow.some((f) => f.key === key) ? 'valid' : 'undeclared';
  }

  return 'undeclared';
}

type TemplateRange = { start: number; end: number; path: string; raw: string };

/** Non-global regex factory — avoids shared `lastIndex` bugs. */
function templatePlaceholderRegex(): RegExp {
  return new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g');
}

export function extractTemplateRanges(text: string): TemplateRange[] {
  const re = templatePlaceholderRegex();
  const out: TemplateRange[] = [];
  for (const m of text.matchAll(re)) {
    const path = m[1]?.trim();
    if (path === undefined || path === '') continue;
    const full = m[0];
    if (m.index === undefined) continue;
    out.push({ start: m.index, end: m.index + full.length, path, raw: full });
  }
  return out;
}

export function warningMessageForPlaceholder(
  path: string,
  tone: TemplateVarTone,
  vars: NodeVariables | null | undefined,
): string | null {
  if (tone === 'valid') return null;

  const root = path.trim().split('.').filter(Boolean)[0] ?? '';
  const availablePrevious =
    (vars?.previous?.map((f) => `previous.${f.key}`) ?? []).join(', ') || '(none)';
  const availableFlowList =
    vars?.flow && vars.flow.length > 0 ? vars.flow.map((f) => `flow.${f.key}`).join(', ') : null;

  if (tone === 'dynamic') {
    if (root === 'trigger') {
      // Deeper path into an open-ended field (payload = raw webhook body) → provider-
      // specific, can't verify. Otherwise it's a batch (manual_trigger) arbitrary key.
      const seg1 = path.trim().split('.').filter(Boolean)[1];
      const top = vars?.trigger.find((t) => t.key === seg1);
      if (top?.openEnded) {
        return `{{${path}}} reads into the raw webhook body — field names are provider-specific, so it can't be verified here and resolves only if the event includes that path. Prefer a friendly field (e.g. {{trigger.story.title}}) where available.`;
      }
      return `{{${path}}} is not declared in this flow's Batch trigger variables schema. It will resolve at runtime if the CEO agent includes it in triggerContext via frink_flows_define_stages. Declare it in Flow Settings → Batch trigger variables to validate it here and get chip-level autocomplete.`;
    }
    const isFlowRoot = root === 'flow';
    const scope = isFlowRoot ? 'declared flow fields' : 'declared predecessor fields';
    const list = isFlowRoot ? (availableFlowList ?? '(none)') : availablePrevious;
    return `{{${path}}} is not in the ${scope} (${list}). It may still work if the upstream step outputs JSON with that key — add expectedOutputs on Run Command or declare outputs in the custom node manifest to validate.`;
  }

  if (root === 'trigger' && vars && vars.trigger.length === 0) {
    return `{{${path}}} — this trigger type does not provide template variables.`;
  }

  if (root === 'flow') {
    return `{{${path}}} is retired and resolves to an empty string. The flow briefing now reaches every agent automatically as a system prompt — remove this placeholder.`;
  }

  const availabilityLine =
    root === 'flow' && availableFlowList !== null
      ? `Available flow: ${availableFlowList}`
      : `Available previous: ${availablePrevious}`;

  return `{{${path}}} does not match any available variable for this step. ${availabilityLine}.`;
}
