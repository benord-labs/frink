import { describe, expect, it } from 'vitest';
import type { FlowGraph, FlowNode } from '../../../shared/lib/validate-flow-graph';
import { appStore } from '../jotai-store';
import { analyzeFlow, nodeSeverity, riskiestNodeId } from './analyze';
import {
  clearRehearsal,
  ghostExecAtomFamily,
  ghostRunHeaderStateAtom,
  rehearseFlow,
} from './index';

const FLOW_ID = 'flow-1';

/** Build a graph that wires the given nodes into a single linear chain (n0 → n1 → …). */
function linear(...nodes: FlowNode[]): FlowGraph {
  return {
    nodes,
    edges: nodes.slice(1).map((n, i) => ({ id: `e${i + 1}`, source: nodes[i].id, target: n.id })),
  };
}

const TRIGGER: FlowNode = { id: 'trigger', blockType: 'manual_trigger' };

/** A clean linear flow: manual trigger → start_task → fully-configured agent. */
const cleanGraph = (): FlowGraph =>
  linear(
    TRIGGER,
    { id: 'task', blockType: 'start_task' },
    { id: 'agent', blockType: 'agent', config: { instructions: 'Ship the feature.' } },
  );

describe('analyzeFlow — determinism', () => {
  it('identical duplicated nodes get IDENTICAL findings (no node-id hashing)', () => {
    // Two run_command nodes with the exact same (empty) config — they must produce the same
    // finding set, never one pass + one fail.
    const g = linear(
      TRIGGER,
      { id: 'cmd-a', blockType: 'run_command', config: {} },
      { id: 'cmd-b', blockType: 'run_command', config: {} },
    );
    const findings = analyzeFlow(g);
    const rulesFor = (id: string) =>
      findings
        .filter((f) => f.nodeId === id)
        .map((f) => f.rule)
        .sort();
    expect(rulesFor('cmd-a')).toEqual(rulesFor('cmd-b'));
    expect(rulesFor('cmd-a')).toContain('run_command.missing_command');
  });

  it('is a pure function — same graph in, same findings out', () => {
    const g = cleanGraph();
    expect(analyzeFlow(g)).toEqual(analyzeFlow(g));
  });
});

describe('analyzeFlow — a clean flow', () => {
  it('produces zero findings', () => {
    expect(analyzeFlow(cleanGraph())).toEqual([]);
  });
});

describe('analyzeFlow — each rule fires on a crafted bad node', () => {
  it('run_command with no command', () => {
    const g = linear(TRIGGER, { id: 'c', blockType: 'run_command', config: { command: '   ' } });
    expect(analyzeFlow(g).some((f) => f.rule === 'run_command.missing_command')).toBe(true);
  });

  it('agent with an empty prompt', () => {
    const g = linear(
      TRIGGER,
      { id: 'st', blockType: 'start_task' },
      { id: 'a', blockType: 'agent', config: { instructions: '' } },
    );
    expect(analyzeFlow(g).some((f) => f.rule === 'agent.empty_prompt')).toBe(true);
  });

  it('agent with no upstream task creator', () => {
    const g = linear(TRIGGER, { id: 'a', blockType: 'agent', config: { instructions: 'Do it.' } });
    expect(analyzeFlow(g).some((f) => f.rule === 'agent.no_task_creator')).toBe(true);
  });

  it('condition missing a required branch', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cond', blockType: 'condition' },
        { id: 'end', blockType: 'end' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'end', sourceHandle: 'true' },
        // no 'false' branch
      ],
    };
    const rules = analyzeFlow(g).map((f) => f.rule);
    expect(rules).toContain('condition.missing_false_branch');
    expect(rules).not.toContain('condition.missing_true_branch');
  });

  it('webhook trigger missing integration + event', () => {
    const g = linear(
      { id: 'wh', blockType: 'webhook_trigger', config: {} },
      { id: 'st', blockType: 'start_task' },
    );
    const rules = analyzeFlow(g).map((f) => f.rule);
    expect(rules).toContain('webhook_trigger.missing_integration');
    expect(rules).toContain('webhook_trigger.missing_event');
  });

  it('http_request with no URL', () => {
    const g = linear(TRIGGER, { id: 'h', blockType: 'http_request', config: {} });
    expect(analyzeFlow(g).some((f) => f.rule === 'http_request.missing_url')).toBe(true);
  });

  it('unreachable non-trigger node (no incoming edge)', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task' },
        { id: 'orphan', blockType: 'end' },
      ],
      edges: [{ id: 'e1', source: 't', target: 'st' }],
    };
    const orphanFindings = analyzeFlow(g).filter((f) => f.nodeId === 'orphan');
    expect(orphanFindings.some((f) => f.rule === 'node.unreachable')).toBe(true);
  });

  it('template reference to a variable no upstream node produces', () => {
    const g = linear(
      TRIGGER,
      { id: 'st', blockType: 'start_task' },
      { id: 'a', blockType: 'agent', config: { instructions: 'Use {{previous.doesNotExist}}.' } },
    );
    expect(analyzeFlow(g).some((f) => f.rule.startsWith('template.'))).toBe(true);
  });

  it('one bad placeholder in two http_request headers yields two distinct findings (sc-3172)', () => {
    // Rule ids double as React keys, so both headers must keep their own field in the id.
    const g = linear(
      TRIGGER,
      { id: 'up', blockType: 'http_request', config: { url: 'https://example.com' } },
      {
        id: 'h',
        blockType: 'http_request',
        config: {
          url: 'https://example.com',
          headers: { Authorization: '{{previous.idd}}', 'X-Id': '{{previous.idd}}' },
        },
      },
    );
    const rules = analyzeFlow(g)
      .filter((f) => f.nodeId === 'h' && f.rule.startsWith('template.'))
      .map((f) => f.rule);
    expect(rules).toEqual([
      'template.headers.Authorization.{{previous.idd}}',
      'template.headers.X-Id.{{previous.idd}}',
    ]);
  });
});

describe('riskiestNodeId / nodeSeverity', () => {
  it('picks the error-severity node over a warn-severity node', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: {} }, // error: missing command
        { id: 'orphan', blockType: 'end' }, // warn: unreachable
      ],
      edges: [{ id: 'e1', source: 't', target: 'cmd' }],
    };
    const findings = analyzeFlow(g);
    expect(riskiestNodeId(findings)).toBe('cmd');
  });

  it('nodeSeverity returns the highest severity present', () => {
    const findings = analyzeFlow({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: {} },
      ],
      edges: [{ id: 'e1', source: 't', target: 'cmd' }],
    });
    expect(nodeSeverity(findings.filter((f) => f.nodeId === 'cmd'))).toBe('error');
  });
});

describe('rehearseFlow — atom writes', () => {
  it('paints a clean flow with no findings and an honest header', async () => {
    const g = cleanGraph();
    const states = await rehearseFlow(FLOW_ID, g);
    for (const node of g.nodes) {
      const s = states.get(node.id);
      expect(s?.status).toBe('completed');
      expect(s?.findings).toEqual([]);
      expect(s?.isAtRisk).toBeUndefined();
    }
    const header = appStore.get(ghostRunHeaderStateAtom);
    expect(header?.findingCount).toBe(0);
    expect(header?.affectedNodeCount).toBe(0);
    expect(header?.errorCount).toBe(0);
    expect(header?.nodeCount).toBe(3);
    expect(header?.riskiestNodeId).toBeNull();
  });

  it('is deterministic across runs (identical state for the same graph)', async () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd-a', blockType: 'run_command', config: {} },
        { id: 'cmd-b', blockType: 'run_command', config: {} },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'cmd-a' },
        { id: 'e2', source: 'cmd-a', target: 'cmd-b' },
      ],
    };
    const first = await rehearseFlow(FLOW_ID, g);
    const second = await rehearseFlow(FLOW_ID, g);
    for (const id of ['cmd-a', 'cmd-b']) {
      expect(first.get(id)?.findings.map((f) => f.rule)).toEqual(
        second.get(id)?.findings.map((f) => f.rule),
      );
    }
  });

  it('marks exactly one node at-risk (the highest-severity finding)', async () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: {} },
        { id: 'orphan', blockType: 'end' },
      ],
      edges: [{ id: 'e1', source: 't', target: 'cmd' }],
    };
    const states = await rehearseFlow(FLOW_ID, g);
    const atRisk = [...states.values()].filter((s) => s.isAtRisk);
    expect(atRisk).toHaveLength(1);
    expect(states.get('cmd')?.isAtRisk).toBe(true);
    expect(appStore.get(ghostRunHeaderStateAtom)?.riskiestNodeId).toBe('cmd');
  });

  it('writes per-node ghost atoms', async () => {
    const g = cleanGraph();
    await rehearseFlow(FLOW_ID, g);
    expect(appStore.get(ghostExecAtomFamily(`${FLOW_ID}:trigger`))?.status).toBe('completed');
  });

  it('clearRehearsal blanks node atoms and the header', async () => {
    const g = cleanGraph();
    await rehearseFlow(FLOW_ID, g);
    clearRehearsal(FLOW_ID, g);
    expect(appStore.get(ghostExecAtomFamily(`${FLOW_ID}:trigger`))).toBeNull();
    expect(appStore.get(ghostRunHeaderStateAtom)).toBeNull();
  });
});
