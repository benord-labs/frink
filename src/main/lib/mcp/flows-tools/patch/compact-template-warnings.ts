/** Bounds the template warnings a frink_flows_patch receipt carries, at any flow size. */

import type { TemplateVariableWarning } from '../../../../../shared/lib/validate-flow-templates';

/** Count-based, always applied: the receipt's shape never depends on how large it would be. */
export const MAX_TEMPLATE_WARNINGS = 20;

/** The labels a validator message puts in front of the field list it quotes. */
const LIST_LABELS = ['Available: ', 'Declared: '];

export type CompactedTemplateWarnings = {
  shown: TemplateVariableWarning[];
  /** Each distinct field list the shown warnings quote, once; messages name their key. */
  availableFields: Record<string, string[]>;
  suppressed: number;
};

function referToList(message: string, list: string, key: string): string | undefined {
  for (const label of LIST_LABELS) {
    const quoted = `${label}${list}`;
    if (message.includes(quoted))
      return message.replace(quoted, `${label}see availableFields.${key}`);
  }
  return undefined;
}

/**
 * Keeps the first MAX_TEMPLATE_WARNINGS in validator order and sends each quoted field list once.
 * Lists are keyed by content, not by predecessor id: a merged predecessor schema has no single id.
 */
export function compactTemplateWarnings(
  warnings: readonly TemplateVariableWarning[],
): CompactedTemplateWarnings {
  const keyByList = new Map<string, string>();
  const availableFields: Record<string, string[]> = {};
  const shown = warnings.slice(0, MAX_TEMPLATE_WARNINGS).map((warning) => {
    const { availableFields: fields, ...rest } = warning;
    if (!fields) return rest;
    const list = fields.join(', ');
    const key = keyByList.get(list) ?? `fields${keyByList.size + 1}`;
    const message = referToList(rest.message, list, key);
    if (message === undefined) return rest;
    if (!keyByList.has(list)) {
      keyByList.set(list, key);
      availableFields[key] = fields;
    }
    return { ...rest, message };
  });
  return { shown, availableFields, suppressed: warnings.length - shown.length };
}
