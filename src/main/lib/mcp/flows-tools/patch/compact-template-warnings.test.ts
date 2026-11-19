import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import {
  computeNodeVariables,
  type TemplateVariableWarning,
  validateFlowTemplateVariables,
} from '../../../../../shared/lib/validate-flow-templates';
import { compactTemplateWarnings, MAX_TEMPLATE_WARNINGS } from './compact-template-warnings';

function chain(blockTypes: string[], placeholder: string): FlowGraph {
  const nodes: FlowGraph['nodes'] = [
    ...blockTypes.map((blockType, index) => ({ id: `n${index}`, blockType, config: {} })),
    { id: 'last', blockType: 'agent', config: { instructions: placeholder } },
  ];
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `e${index}`,
      source: nodes[index]?.id ?? '',
      target: node.id,
    })),
  };
}

// The catalog outputs the MCP caller supplies for plugin nodes (patch-template-warnings.ts).
const PLUGIN_OUTPUTS = new Map([
  [
    'clickup_create_task',
    [{ key: 'id', type: 'string' as const, description: 'Task id', guaranteed: true }],
  ],
]);

// Every validator message that quotes a field list, so a wording change cannot silently stop the dedupe.
const LIST_QUOTING_WARNINGS: Array<[string, FlowGraph, string]> = [
  [
    'unknown previous field',
    chain(['manual_trigger', 'agent'], '{{previous.nope}}'),
    '{{previous.nope}}',
  ],
  [
    'undeclared dynamic field',
    chain(['manual_trigger', 'run_command'], '{{previous.nope}}'),
    '{{previous.nope}}',
  ],
  [
    'plugin catalog field',
    chain(['manual_trigger', 'clickup_create_task'], '{{previous.nope}}'),
    '{{previous.nope}}',
  ],
  [
    'webhook trigger field',
    chain(['webhook_trigger'], '{{trigger.repository}}'),
    '{{trigger.repository}}',
  ],
  ['schedule trigger field', chain(['schedule_trigger'], '{{trigger.nope}}'), '{{trigger.nope}}'],
];

function unknownField(nodeId: string, key: string, fields: string[]): TemplateVariableWarning {
  return {
    nodeId,
    field: 'instructions',
    placeholder: `{{previous.${key}}}`,
    message: `{{previous.${key}}} references an unknown output field. Available: ${fields.join(', ')}. See the skill.`,
    availableFields: fields,
  };
}

const LIST_A = ['previous.title', 'previous.body'];
const LIST_B = ['previous.exitCode'];

describe('compactTemplateWarnings', () => {
  it('sends each distinct field list once and points every message at its own list', () => {
    const { shown, availableFields, suppressed } = compactTemplateWarnings([
      unknownField('a1', 'titel', LIST_A),
      unknownField('a2', 'bdy', LIST_A),
      unknownField('b1', 'code', LIST_B),
    ]);

    expect(availableFields).toEqual({ fields1: LIST_A, fields2: LIST_B });
    expect(shown.map((w) => w.message)).toEqual([
      '{{previous.titel}} references an unknown output field. Available: see availableFields.fields1. See the skill.',
      '{{previous.bdy}} references an unknown output field. Available: see availableFields.fields1. See the skill.',
      '{{previous.code}} references an unknown output field. Available: see availableFields.fields2. See the skill.',
    ]);
    expect(shown.every((w) => !('availableFields' in w))).toBe(true);
    expect(suppressed).toBe(0);
  });

  it('replaces the quoted list, not a placeholder that happens to contain the same text', () => {
    const { shown } = compactTemplateWarnings([unknownField('n', 'exitCodes', LIST_B)]);

    expect(shown[0]?.message).toBe(
      '{{previous.exitCodes}} references an unknown output field. Available: see availableFields.fields1. See the skill.',
    );
  });

  it('rewrites the list after the placeholder even when the placeholder repeats that text', () => {
    const fields = ['previous.title', 'previous.body'];
    const placeholder = '{{previous.Available: previous.title, previous.body}}';
    const warning: TemplateVariableWarning = {
      nodeId: 'n',
      field: 'instructions',
      placeholder,
      message: `${placeholder} references an unknown output field. Available: ${fields.join(', ')}. See the skill.`,
      availableFields: fields,
    };

    expect(compactTemplateWarnings([warning]).shown[0]?.message).toBe(
      `${placeholder} references an unknown output field. Available: see availableFields.fields1. See the skill.`,
    );
  });

  it('caps the list in graph order, counts the rest, and keeps only the lists still shown', () => {
    const warnings = [
      ...Array.from({ length: MAX_TEMPLATE_WARNINGS }, (_, i) =>
        unknownField(`a${i}`, 'x', LIST_A),
      ),
      ...Array.from({ length: 5 }, (_, i) => unknownField(`b${i}`, 'y', LIST_B)),
    ];

    const { shown, availableFields, suppressed } = compactTemplateWarnings(warnings);

    expect(shown).toHaveLength(MAX_TEMPLATE_WARNINGS);
    expect(shown.at(-1)?.nodeId).toBe(`a${MAX_TEMPLATE_WARNINGS - 1}`);
    expect(suppressed).toBe(5);
    expect(availableFields).toEqual({ fields1: LIST_A });
  });

  it.each(LIST_QUOTING_WARNINGS)(
    'moves the real %s list out of its message',
    (_, graph, placeholder) => {
      const warning = validateFlowTemplateVariables(
        graph,
        computeNodeVariables(graph, { customNodeOutputs: PLUGIN_OUTPUTS }),
      ).find((w) => w.placeholder === placeholder);
      const listed = warning?.availableFields ?? [];

      const { shown, availableFields } = compactTemplateWarnings(warning ? [warning] : []);
      const key = /see availableFields\.(\w+)/.exec(shown[0]?.message ?? '')?.[1] ?? '';

      expect(listed.length).toBeGreaterThan(0);
      expect(availableFields[key]).toEqual(listed);
      expect(shown[0]?.message).not.toContain(listed.join(', '));
    },
  );

  it('keeps a full list of exactly MAX warnings without counting any as suppressed', () => {
    const warnings = Array.from({ length: MAX_TEMPLATE_WARNINGS }, (_, i) =>
      unknownField(`a${i}`, 'x', LIST_A),
    );

    const { shown, suppressed } = compactTemplateWarnings(warnings);

    expect(shown).toHaveLength(MAX_TEMPLATE_WARNINGS);
    expect(suppressed).toBe(0);
  });

  it('leaves a warning that quotes no list untouched', () => {
    const shell: TemplateVariableWarning = {
      nodeId: 'cmd',
      field: 'command',
      placeholder: '{{trigger.summary}}',
      message: 'Wrapping this value in quotes turns it into executable shell syntax.',
    };

    expect(compactTemplateWarnings([shell])).toEqual({
      shown: [shell],
      availableFields: {},
      suppressed: 0,
    });
  });
});
