/**
 * Shared schema-table builders used by multiple `frink-flows` skill reference
 * files. Produces Markdown tables generated from the canonical runtime data in
 * `src/shared/lib/output-schemas.ts`, so block output / trigger context / loop
 * context documentation can never drift from runtime behaviour.
 */

import { TRIGGER_FIELD_ALIASES } from '../../../../../shared/integrations/trigger-field-aliases';
import {
  LOOP_CONTEXT_SCHEMA,
  OUTPUT_SCHEMAS,
  TRIGGER_SCHEMAS,
} from '../../../../../shared/lib/output-schemas';

/** Emit one block's runtime fields beside its config contract. */
export function buildOutputSchemasSection(blockType: string): string {
  const fields = OUTPUT_SCHEMAS[blockType] ?? [];
  if (fields.length === 0) return 'Outputs: none.\n';
  return [
    '| output | type | guaranteed | description |',
    '|---|---|---|---|',
    ...fields.map((f) => `| \`${f.key}\` | ${f.type} | ${f.guaranteed ? 'yes' : 'no'} | ${f.description} |`),
    '',
  ].join('\n');
}

export function buildLoopContextSection(): string {
  const lines: string[] = [
    '## Loop context schemas (`{{loop.*}}`)',
    '',
    'Available on every node owned by a fan_out through `parentId`.',
    '`{{loop.currentItem.*}}` fields depend on the upstream node feeding the fan_out.',
    '',
    '| field | type | guaranteed | description |',
    '|-------|------|------------|-------------|',
  ];
  for (const f of LOOP_CONTEXT_SCHEMA) {
    lines.push(`| \`${f.key}\` | ${f.type} | ${f.guaranteed ? 'yes' : 'no'} | ${f.description} |`);
  }
  lines.push(
    `| \`currentItem\` | unknown | yes | Current array element — use dot notation for object fields: \`{{loop.currentItem.title}}\` |`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Emit one trigger's context beside its config contract. */
export function buildTriggerSchemasSection(triggerType: string): string {
  return [
    '| trigger field | type | description |',
    '|---|---|---|',
    ...(TRIGGER_SCHEMAS[triggerType] ?? []).map(
      (f) => `| \`${f.key}\` | ${f.type} | ${f.description} |`,
    ),
    '',
  ].join('\n');
}

/**
 * Per-provider friendly trigger aliases (`{{trigger.story.title}}` …), generated
 * from {@link TRIGGER_FIELD_ALIASES} so the skill can never drift from the map the
 * runtime + editor read. Without this, an MCP/CEO flow author has no way to discover
 * the friendly aliases (they only ever saw the raw `payload` row).
 */
export function buildTriggerAliasesSection(): string {
  const lines: string[] = [
    '## Friendly webhook aliases (`{{trigger.<alias>}}`)',
    '',
    'For supported providers, prefer these readable aliases over raw `{{trigger.payload.*}}` paths — they are shorter, validated in the editor, and stable across payload shape changes. An absent field renders empty (never a literal `{{...}}`). Unlisted providers: use `{{trigger.payload.*}}` (the raw webhook body).',
    '',
  ];
  for (const [provider, aliases] of Object.entries(TRIGGER_FIELD_ALIASES)) {
    lines.push(`### ${provider}`);
    lines.push('| alias | type | from (raw payload path) | description |');
    lines.push('|-------|------|-------------------------|-------------|');
    for (const a of aliases) {
      const from = (Array.isArray(a.path) ? a.path : [a.path]).map((p) => `\`${p}\``).join(' or ');
      lines.push(
        `| \`{{trigger.${a.alias}}}\` | ${a.type} | ${from} | ${a.description ?? a.label} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
