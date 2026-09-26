/**
 * Build the variable context for `{{trigger.*}}`, `{{previous.*}}`, `{{loop.*}}`
 * template substitution at dispatch time.
 *
 * Source-of-truth for path resolution + escaping is `template-utils.ts`. This
 * module just assembles the dict.
 */

import { applyTriggerAliases } from '../../../shared/lib/flow-trigger-aliases';
import { applyProviderAliases } from '../../../shared/lib/provider-trigger-aliases';
import type { NodeOutput } from '../../../shared/types/flow';

type FlowVariableContext = {
  trigger?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  loop?: Record<string, unknown>;
  flow?: { briefing?: string };
};

/** previous.* is the predecessor's flat outputs bag — matches the cloud engine's contract. */
function toPreviousContext(output: NodeOutput | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined;
  return output.outputs;
}

export function buildVariables(args: {
  triggerContext: Record<string, unknown> | null | undefined;
  previousOutput: NodeOutput | undefined;
  loopContext?: Record<string, unknown>;
  flowBriefing?: string;
}): Record<string, unknown> {
  const ctx: FlowVariableContext = {};
  if (args.triggerContext) {
    // event/payload aliases first, then friendly per-provider aliases
    // (e.g. trigger.story.title ← payload.actions.0.name) layered on top.
    ctx.trigger = applyProviderAliases(applyTriggerAliases(args.triggerContext));
  }
  const prev = toPreviousContext(args.previousOutput);
  if (prev) ctx.previous = prev;
  if (args.loopContext) ctx.loop = args.loopContext;
  if (args.flowBriefing !== undefined) ctx.flow = { briefing: args.flowBriefing };
  return ctx as Record<string, unknown>;
}
