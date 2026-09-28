/** Caps the AUTHORED agent prose templates (trimmed); above it the node fails — never sliced (sc-3166).
 *  Rendered output is not capped: resolved {{…}} values are spliced whole, each bounded upstream. */

import { type FlowNode, formatFlowNodeLabel } from '../validate-flow-graph';
import type { TemplateVariableWarning } from '../validate-flow-templates';

export const MAX_AGENT_PROSE_LENGTH = 50_000;

/** Authoring-time warning threshold: 80% of {@link MAX_AGENT_PROSE_LENGTH}. */
export const AGENT_PROSE_WARN_LENGTH = 40_000;

const AGENT_PROSE_FIELDS = ['instructions', 'agentInstructions'] as const;

export type AgentProseField = (typeof AGENT_PROSE_FIELDS)[number];

/** Trimmed length of each prose field that holds a string; non-string values are skipped. */
function agentProseLengths(
  config: Record<string, unknown> | undefined,
): { field: AgentProseField; length: number }[] {
  if (!config) return [];
  return AGENT_PROSE_FIELDS.flatMap((field) => {
    const value = config[field];
    return typeof value === 'string' ? [{ field, length: value.trim().length }] : [];
  });
}

/** The first prose field over {@link MAX_AGENT_PROSE_LENGTH}, or undefined when all fit. */
export function findAgentProseOverflow(
  config: Record<string, unknown> | undefined,
): { field: AgentProseField; length: number } | undefined {
  return agentProseLengths(config).find(({ length }) => length > MAX_AGENT_PROSE_LENGTH);
}

/** Near the cap but still within it — the band that earns an authoring-time warning. */
export function isNearAgentProseCap(length: number): boolean {
  return length >= AGENT_PROSE_WARN_LENGTH && length <= MAX_AGENT_PROSE_LENGTH;
}

/** Characters left for the editor counter, or undefined below the warning threshold. */
export function agentProseCharsLeft(length: number): number | undefined {
  return length >= AGENT_PROSE_WARN_LENGTH
    ? Math.max(0, MAX_AGENT_PROSE_LENGTH - length)
    : undefined;
}

export function describeAgentProseOverflow(field: AgentProseField, length: number): string {
  return `${field} is ${length.toLocaleString('en-US')} characters; the limit is ${MAX_AGENT_PROSE_LENGTH.toLocaleString('en-US')}`;
}

/** Why an editor write of `next` over `current` instructions is refused, or undefined to apply
 *  it. A shrinking edit always applies, so a legacy over-cap prompt can still be cut down. */
export function agentProseEditRejection(current: string, next: string): string | undefined {
  const overflow = findAgentProseOverflow({ instructions: next });
  if (!overflow || overflow.length <= current.trim().length) return undefined;
  return describeAgentProseOverflow(overflow.field, overflow.length);
}

/** One error per agent node whose prose is over the cap; phrased like validateGraph's errors. */
export function agentProseGraphErrors(nodes: readonly FlowNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.blockType !== 'agent') return [];
    const overflow = findAgentProseOverflow(node.config);
    return overflow
      ? [
          `Agent node "${formatFlowNodeLabel(node)}" ${describeAgentProseOverflow(overflow.field, overflow.length)}`,
        ]
      : [];
  });
}

/** Authoring-time warnings for agent prose in the near-cap band; over the cap is an error instead. */
export function agentProseGraphWarnings(nodes: readonly FlowNode[]): TemplateVariableWarning[] {
  return nodes.flatMap((node) =>
    node.blockType !== 'agent'
      ? []
      : agentProseLengths(node.config)
          .filter(({ length }) => isNearAgentProseCap(length))
          .map(({ field, length }) => ({
            nodeId: node.id,
            field,
            placeholder: '',
            message: `${field} is ${length.toLocaleString('en-US')} of ${MAX_AGENT_PROSE_LENGTH.toLocaleString('en-US')} characters — near the agent prompt limit`,
          })),
  );
}
