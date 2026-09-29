import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPatchOperations,
  patchArgsSchema,
} from '../../src/main/lib/mcp/flows-tools/flow-patch';
import { resolveFanOutStructure } from '../../src/shared/lib/compute-fan-out-body-chain';
import { validateGraph, type FlowGraph } from '../../src/shared/lib/validate-flow-graph';
import { validateFlowTemplateVariables } from '../../src/shared/lib/validate-flow-templates';
import { renderTemplate } from '../../src/main/lib/flows/template-utils';
import { evaluateCondition } from '../../src/main/lib/flows/condition-eval';
import type { ConditionPredicate } from '../../src/shared/types/flow';
import { OUTPUT_SCHEMAS, TRIGGER_SCHEMAS } from '../../src/shared/lib/output-schemas';

import { dispatchFanOut } from '../../src/main/lib/flows/dispatch/fan-out';

const references = join(process.cwd(), 'assets/skills/frink-flows/references');
const documents = readdirSync(references)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, text: readFileSync(join(references, name), 'utf8') }));
const patches = documents.flatMap(({ text }) =>
  [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((example) => Object.hasOwn(example, 'name') && Object.hasOwn(example, 'operations'))
    .map((example) => patchArgsSchema.parse(example)),
);

function documentedGraph(): FlowGraph {
  const result = applyPatchOperations({ nodes: [], edges: [] }, patches[0].operations);
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error('Documented patch must apply completely');
  return result.graph;
}

describe('shipped flow skill', () => {
  it('keeps references bounded and the intended patch example discoverable', () => {
    expect(patches.map((patch) => patch.name)).toEqual(['Fan-out report']);
    for (const { name, text } of documents) {
      expect(Buffer.byteLength(text), name).toBeLessThanOrEqual(8192);
    }
  });

  it('applies every complete example unchanged and validates execution as well as save', () => {
    for (const patch of patches) {
      const result = applyPatchOperations({ nodes: [], edges: [] }, patch.operations);
      expect(result.status, patch.name).toBe('success');
      if (result.status !== 'success') throw new Error(JSON.stringify(result));
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(validateGraph(result.graph, { mode: 'save' })).toEqual({ valid: true });
      expect(validateGraph(result.graph, { mode: 'run' })).toEqual({ valid: true });
      expect(validateFlowTemplateVariables(result.graph)).toEqual([]);
    }
  });

  it('uses distinct contained roots with a shared continuation and rejects a bypass', () => {
    const graph = documentedGraph();
    const fan = graph.nodes.find((node) => node.blockType === 'fan_out')!;
    const resolved = resolveFanOutStructure(graph.nodes, graph.edges, fan.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.message);
    expect(resolved.structure.branches.map((branch) => branch.rootNodeId)).toEqual([
      'review',
      'count',
    ]);
    expect(resolved.structure.continuationNodeId).toBe('report');
    graph.edges.push({ id: 'bypass', source: 'items', target: 'report' });
    expect(validateGraph(graph, { mode: 'run' }).errors).toContain(
      'Fan Out "Fan Out" continuation can only receive edges from this Fan Out body tails',
    );
  });

  it('renders the documented branch-root result and routes both condition outcomes', () => {
    const graph = documentedGraph();
    const condition = graph.nodes.find((node) => node.blockType === 'condition')!;
    // SAFETY: the complete documented graph passes run-mode predicate validation in this suite.
    const predicate = condition.config?.predicate as ConditionPredicate;
    expect(
      evaluateCondition(predicate, {
        status: 'completed',
        outputs: { count: 2 },
        artifacts: [],
        durationMs: 0,
      }),
    ).toBe('continue');
    expect(
      evaluateCondition(predicate, {
        status: 'completed',
        outputs: { count: 0 },
        artifacts: [],
        durationMs: 0,
      }),
    ).toBe('stop');
    const outputs = {
      totalCount: 2,
      results: [{ review: { _rawStdout: 'alpha' }, count: { count: 1 } }],
    };
    const report = graph.nodes.find((node) => node.config?.contentType === 'html_artifact')!;
    expect(
      renderTemplate(String(report.config?.artifactBodyHtmlTemplate), { previous: outputs }),
    ).toBe('<h1>Processed 2 items</h1><p>First result: alpha</p>');
  });

  it('accepts the documented fan-out mode in the desktop dispatcher', async () => {
    const graph = documentedGraph();
    const node = graph.nodes.find((entry) => entry.blockType === 'fan_out')!;
    const result = await dispatchFanOut({
      flowRunId: 'flow-run',
      nodeRunId: 'fan-run',
      userId: 'u1',
      node,
      previousOutput: {
        status: 'completed',
        outputs: { items: [] },
        artifacts: [],
        durationMs: 0,
      },
      triggerContext: null,
      parsedGraph: graph,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      type: 'completed',
      output: { outputs: { results: [], totalCount: 0, _fanOutState: 'completed' } },
    });
  });

  it('keeps every runtime output and trigger field in its block contract', () => {
    const all = documents.map(({ text }) => text).join('\n');
    for (const fields of [...Object.values(OUTPUT_SCHEMAS), ...Object.values(TRIGGER_SCHEMAS)]) {
      for (const field of fields) expect(all).toContain(`| \`${field.key}\` | ${field.type} |`);
    }
  });
});
