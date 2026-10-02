/** Fan Out completion fields resolved through a Condition continuation (sc-3578). */
import { describe, expect, it } from 'vitest';
import type { OutputFieldSchema } from './output-schemas';
import type { FlowGraph } from './validate-flow-graph';
import { computeNodeVariables, validateFlowTemplateVariables } from './validate-flow-templates';

const makeGraph = (nodes: FlowGraph['nodes'], edges?: FlowGraph['edges']): FlowGraph => ({
  nodes,
  edges:
    edges ??
    nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]?.id ?? '', target: n.id })),
});

describe('fan out completion through a Condition (sc-3578)', () => {
  function conditionContinuationGraph(messageTemplate: string): FlowGraph {
    return makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'b1', blockType: 'agent', parentId: 'fo' },
        { id: 'b2', blockType: 'agent', parentId: 'fo' },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'totalCount', operator: 'gt', value: 0 } },
        },
        { id: 'reply', blockType: 'chat_reply', config: { messageTemplate } },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'b1' },
        { id: 'e3', source: 'fo', target: 'b2' },
        { id: 'e4', source: 'b1', target: 'cond' },
        { id: 'e5', source: 'b2', target: 'cond' },
        { id: 'e6', source: 'cond', target: 'reply' },
      ],
    );
  }

  it('passes the completed Fan Out schema through a Condition continuation', () => {
    const graph = conditionContinuationGraph(
      '{{previous.totalCount}} items: {{previous.results.0.b1}}',
    );
    const keys = computeNodeVariables(graph).reply?.previous.map((field) => field.key);
    expect(keys).toEqual(expect.arrayContaining(['results', 'totalCount', 'result']));
    expect(validateFlowTemplateVariables(graph)).toEqual([]);
  });

  it('still warns on an undeclared field after the Condition', () => {
    const warnings = validateFlowTemplateVariables(
      conditionContinuationGraph('{{previous.bogus}}'),
    );
    expect(warnings.some((w) => w.placeholder === '{{previous.bogus}}')).toBe(true);
  });

  it('still warns on the wrapper form previous.output.*, which renders empty at runtime', () => {
    const warnings = validateFlowTemplateVariables(
      conditionContinuationGraph('{{previous.output.totalCount}}'),
    );
    expect(warnings.some((w) => w.placeholder === '{{previous.output.totalCount}}')).toBe(true);
  });

  it('carries the Fan Out schema through chained Conditions', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'b1', blockType: 'agent', parentId: 'fo' },
        { id: 'cond1', blockType: 'condition' },
        { id: 'cond2', blockType: 'condition' },
        { id: 'reply', blockType: 'chat_reply' },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'b1' },
        { id: 'e3', source: 'b1', target: 'cond1' },
        { id: 'e4', source: 'cond1', target: 'cond2' },
        { id: 'e5', source: 'cond2', target: 'reply' },
      ],
    );
    const keys = computeNodeVariables(graph).reply?.previous.map((field) => field.key);
    expect(keys).toEqual(expect.arrayContaining(['results', 'totalCount', 'result']));
  });

  it('does not leak Fan Out fields past a continuation that produces its own outputs', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'b1', blockType: 'agent', parentId: 'fo' },
        { id: 'agentC', blockType: 'agent' },
        { id: 'cond', blockType: 'condition' },
        { id: 'reply', blockType: 'chat_reply' },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'b1' },
        { id: 'e3', source: 'b1', target: 'agentC' },
        { id: 'e4', source: 'agentC', target: 'cond' },
        { id: 'e5', source: 'cond', target: 'reply' },
      ],
    );
    const vars = computeNodeVariables(graph);
    expect(vars.agentC?.previous.map((field) => field.key)).toContain('totalCount');
    const keys = vars.reply?.previous.map((field) => field.key);
    expect(keys).toContain('result');
    expect(keys).not.toContain('totalCount');
    expect(keys).not.toContain('results');
  });

  it('validates the story shape: an HTML artifact Chat Reply after the Condition', () => {
    const graph = conditionContinuationGraph('');
    const reply = graph.nodes.find((n) => n.id === 'reply');
    if (reply) {
      reply.config = {
        contentType: 'html_artifact',
        artifactTitleTemplate: '{{previous.totalCount}} reports',
        artifactBodyHtmlTemplate: '<p>{{previous.results.0.b1.summary}}</p>',
      };
    }
    expect(validateFlowTemplateVariables(graph)).toEqual([]);
  });

  it('does not inherit dynamic-stdout leniency from run_command body tails', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'b1', blockType: 'run_command', parentId: 'fo', config: { command: 'x' } },
        { id: 'cond', blockType: 'condition' },
        { id: 'reply', blockType: 'chat_reply', config: { messageTemplate: '{{previous.x}}' } },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'b1' },
        { id: 'e3', source: 'b1', target: 'cond' },
        { id: 'e4', source: 'cond', target: 'reply' },
      ],
    );
    const reply = computeNodeVariables(graph).reply;
    expect(reply?.notes.some((n) => n.includes('dynamic'))).toBe(false);
    expect(reply?.singlePredecessorBlockType).toBe('fan_out');
    const w = validateFlowTemplateVariables(graph).find((x) => x.placeholder === '{{previous.x}}');
    expect(w).toBeDefined();
    expect(w?.message).not.toContain('expectedOutputs');
  });

  it('resolves each continuation in sequential Fan Outs', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'foA', blockType: 'fan_out' },
        { id: 'a1', blockType: 'agent', parentId: 'foA' },
        { id: 'foB', blockType: 'fan_out' },
        { id: 'b1', blockType: 'agent', parentId: 'foB' },
        { id: 'cond', blockType: 'condition' },
        { id: 'reply', blockType: 'chat_reply' },
      ],
      [
        { id: 'e1', source: 't', target: 'foA' },
        { id: 'e2', source: 'foA', target: 'a1' },
        { id: 'e3', source: 'a1', target: 'foB' },
        { id: 'e4', source: 'foB', target: 'b1' },
        { id: 'e5', source: 'b1', target: 'cond' },
        { id: 'e6', source: 'cond', target: 'reply' },
      ],
    );
    const vars = computeNodeVariables(graph);
    expect(vars.foB?.previous.map((f) => f.key)).toEqual(
      expect.arrayContaining(['results', 'totalCount']),
    );
    expect(vars.reply?.previous.map((f) => f.key)).toEqual(
      expect.arrayContaining(['results', 'totalCount', 'result']),
    );
  });

  it('terminates when a back-edge loops into the Condition continuation', () => {
    const graph = conditionContinuationGraph('{{previous.result}}');
    graph.edges.push({ id: 'back', source: 'reply', target: 'cond' });
    const vars = computeNodeVariables(graph);
    expect(vars.reply?.previous.map((f) => f.key)).toContain('result');
    expect(() => validateFlowTemplateVariables(graph)).not.toThrow();
  });

  it('threads customNodeOutputs through Condition passthrough', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c', blockType: 'my-script-node', config: {} },
      { id: 'cond', blockType: 'condition' },
      { id: 'ag', blockType: 'agent', config: { instructions: '{{previous.prCount}}' } },
    ]);
    const customNodeOutputs = new Map<string, OutputFieldSchema[]>([
      [
        'my-script-node',
        [{ key: 'prCount', type: 'number', description: 'PRs', guaranteed: true }],
      ],
    ]);
    const keys = computeNodeVariables(graph, { customNodeOutputs }).ag?.previous.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['prCount', 'result']));
    expect(keys).not.toContain('exitCode');
  });

  it('does not offer the aggregate after an Approval continuation, which emits only {approved}', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'b1', blockType: 'agent', parentId: 'fo' },
        { id: 'gate', blockType: 'approval' },
        {
          id: 'reply',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.totalCount}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'b1' },
        { id: 'e3', source: 'b1', target: 'gate' },
        { id: 'e4', source: 'gate', target: 'reply' },
      ],
    );
    expect(computeNodeVariables(graph).reply?.previous.map((f) => f.key)).not.toContain(
      'totalCount',
    );
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.some((w) => w.placeholder === '{{previous.totalCount}}')).toBe(true);
  });
});
