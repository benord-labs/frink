/** Canonical Vitest suite for validate-flow-templates (EC5b/EC5c, etc.). */
import { describe, expect, it } from 'vitest';
import {
  type OutputFieldSchema,
  type RunCommandExpectedOutputs,
  resolveRunCommandOutputSchema,
} from './output-schemas';
import type { FlowGraph } from './validate-flow-graph';
import { computeNodeVariables, validateFlowTemplateVariables } from './validate-flow-templates';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGraph(nodes: FlowGraph['nodes'], edges?: FlowGraph['edges']): FlowGraph {
  if (edges) {
    return { nodes, edges };
  }
  // Auto-wire linear chain
  const autoEdges: { id: string; source: string; target: string }[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const sourceNode = nodes[i];
    const targetNode = nodes[i + 1];
    if (sourceNode === undefined || targetNode === undefined) continue;
    autoEdges.push({ id: `e${i}`, source: sourceNode.id, target: targetNode.id });
  }
  return { nodes, edges: autoEdges };
}

// ---------------------------------------------------------------------------
// computeNodeVariables
// ---------------------------------------------------------------------------

describe('computeNodeVariables', () => {
  it('trigger node has no previous fields', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    // Trigger node has no predecessor
    expect(vars.t?.previous).toEqual([]);
  });

  it('node after run_command: previous has exitCode and _rawStdout', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'schedule_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'exit {{previous.exitCode}}' },
      },
    ]);
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    expect(repVars).toBeDefined();
    const keys = repVars?.previous.map((f) => f.key);
    expect(keys).toContain('exitCode');
    expect(keys).toContain('_rawStdout');
  });

  it('trigger fields come from auto-detected trigger type (schedule_trigger)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'schedule_trigger' },
      { id: 'r', blockType: 'chat_reply', config: { messageTemplate: 'hello' } },
    ]);
    const vars = computeNodeVariables(graph);
    const rVars = vars.r;
    expect(rVars?.trigger.map((f) => f.key)).toContain('scheduledAt');
  });

  it('trigger fields come from post_task_trigger', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'post_task_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    const stVars = vars.st;
    const triggerKeys = stVars?.trigger.map((f) => f.key) ?? [];
    expect(triggerKeys).toContain('result');
    expect(triggerKeys).toContain('branch');
    expect(triggerKeys).toContain('taskId');
  });

  it('manual_trigger has DAG batch dispatch-time trigger fields (baseBranch, baseBranches, mergeStrategy)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    const triggerKeys = vars.r?.trigger.map((f) => f.key) ?? [];
    // sc-611: dispatch-time batch DAG fields injected by signal-bridge
    expect(triggerKeys).toContain('baseBranch');
    expect(triggerKeys).toContain('baseBranches');
    expect(triggerKeys).toContain('mergeStrategy');
  });

  // ---------------------------------------------------------------------------
  // batchTriggerSchema chip rendering (sc-654)
  // ---------------------------------------------------------------------------

  it('sc-654: declared batchTriggerSchema fields appear as trigger chips on manual_trigger flow', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: {
        batchTriggerSchema: [
          { key: 'ticketId', type: 'string', description: 'Ticket identifier' },
          { key: 'workstreamId', type: 'string' },
        ],
      },
    };
    const vars = computeNodeVariables(graph);
    const triggerKeys = vars.r?.trigger.map((f) => f.key) ?? [];
    expect(triggerKeys).toContain('ticketId');
    expect(triggerKeys).toContain('workstreamId');
  });

  it('sc-654: no regression when batchTriggerSchema is absent (EC13)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    // Should still contain the static manual_trigger fields (ticketId is not static — CEO-supplied)
    const triggerKeys = vars.r?.trigger.map((f) => f.key) ?? [];
    expect(triggerKeys).toContain('label');
    expect(triggerKeys).toContain('customInstructions');
    expect(triggerKeys).not.toContain('ticketId');
  });

  it('sc-654: trigger-type gating — batchTriggerSchema ignored on webhook_trigger flows (EC1)', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'webhook_trigger' },
        { id: 'a', blockType: 'agent', config: { instructions: 'hi' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
      settings: {
        batchTriggerSchema: [{ key: 'myField', type: 'string' }],
      },
    };
    const vars = computeNodeVariables(graph);
    const triggerKeys = vars.a?.trigger.map((f) => f.key) ?? [];
    // myField should NOT appear — webhook_trigger doesn't allow arbitrary keys
    expect(triggerKeys).not.toContain('myField');
    // Static webhook_trigger fields should still be there
    expect(triggerKeys).toContain('source');
  });

  it('sc-654: dedup — declared key overlapping static TRIGGER_SCHEMAS key produces one chip (EC2)', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: {
        // 'label' is already a static field in manual_trigger TRIGGER_SCHEMAS
        batchTriggerSchema: [
          { key: 'label', type: 'string', description: 'Override description' },
          { key: 'uniqueField', type: 'number' },
        ],
      },
    };
    const vars = computeNodeVariables(graph);
    const triggerKeys = vars.r?.trigger.map((f) => f.key) ?? [];
    // 'label' appears exactly once
    expect(triggerKeys.filter((k) => k === 'label')).toHaveLength(1);
    // 'uniqueField' appears
    expect(triggerKeys).toContain('uniqueField');
  });

  it('sc-654: invalid batchTriggerSchema type defaults to string in merged trigger fields', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: {
        batchTriggerSchema: [
          { key: 'badType', type: 'foo' },
          { key: 'numOk', type: 'number' },
        ],
      },
    } as unknown as FlowGraph;
    const vars = computeNodeVariables(graph);
    expect(vars.r?.trigger.find((f) => f.key === 'badType')?.type).toBe('string');
    expect(vars.r?.trigger.find((f) => f.key === 'numOk')?.type).toBe('number');
  });

  it('sc-654: omitted batchTriggerSchema item type defaults to string in merged trigger fields', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: {
        batchTriggerSchema: [{ key: 'missingType' }],
      },
    } as unknown as FlowGraph;
    const vars = computeNodeVariables(graph);
    expect(vars.r?.trigger.find((f) => f.key === 'missingType')?.type).toBe('string');
  });

  it('sc-654: empty array batchTriggerSchema produces no extra chips, preserves "any key" note via static fields (EC3)', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: { batchTriggerSchema: [] },
    };
    const vars = computeNodeVariables(graph);
    const triggerKeys = vars.r?.trigger.map((f) => f.key) ?? [];
    // Only static manual_trigger fields
    expect(triggerKeys).toContain('label');
    expect(triggerKeys).toContain('baseBranch');
    // No phantom extra fields
    expect(triggerKeys).not.toContain('');
  });

  it('sc-654: malformed schema items are silently skipped — no crash (EC12)', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'r' }],
      settings: {
        // Intentionally malformed entries mixed with a valid one
        batchTriggerSchema: [
          null as unknown as { key: string; type: 'string' },
          { key: 123 as unknown as string, type: 'string' },
          { key: 'validKey', type: 'string' },
        ],
      },
    };
    expect(() => computeNodeVariables(graph)).not.toThrow();
    const triggerKeys = vars_of(graph, 'r');
    expect(triggerKeys).toContain('validKey');
  });

  it('sc-654: allowsArbitraryTriggerKeys=true on manual_trigger flows', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'agent', config: { instructions: 'hi' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.r?.allowsArbitraryTriggerKeys).toBe(true);
  });

  it('sc-654: allowsArbitraryTriggerKeys is falsy on webhook_trigger flows', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'webhook_trigger' },
      { id: 'r', blockType: 'agent', config: { instructions: 'hi' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.r?.allowsArbitraryTriggerKeys).toBeFalsy();
  });

  it('sc-654: allowsArbitraryTriggerKeys is falsy when no trigger node', () => {
    const graph = makeGraph([{ id: 'r', blockType: 'agent', config: { instructions: 'hi' } }]);
    const vars = computeNodeVariables(graph);
    expect(vars.r?.allowsArbitraryTriggerKeys).toBeFalsy();
  });

  function vars_of(graph: FlowGraph, nodeId: string): string[] {
    return computeNodeVariables(graph)[nodeId]?.trigger.map((f) => f.key) ?? [];
  }

  it('loop fields null for nodes outside fan_out body (EC10)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.r?.loop).toBeNull();
  });

  it('{{flow.*}} scope is retired — flow is null for every agent (primary + continuation)', () => {
    // The Flow Briefing now rides the session system prompt (delivered to every agent), so there is
    // no {{flow.briefing}} var to advertise on any node — primary or continuation alike.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'first' } },
        { id: 'a2', blockType: 'agent', config: { instructions: 'second' } },
      ],
      [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a1' },
        { id: 'e3', source: 'a1', target: 'a2' },
      ],
    );
    const vars = computeNodeVariables(graph);
    expect(vars.a1?.flow).toBeNull();
    expect(vars.a2?.flow).toBeNull();
  });

  it('flow.briefing null for non-agent nodes', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.r?.flow).toBeNull();
    expect(vars.t?.flow).toBeNull();
  });

  it('loop fields available inside fan_out body chain (EC9)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        {
          id: 'body',
          blockType: 'agent',
          parentId: 'fo',
          config: { instructions: 'process {{loop.currentItem}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
      ],
    );
    const vars = computeNodeVariables(graph);
    const bodyVars = vars.body;
    expect(bodyVars?.loop).not.toBeNull();
    const loopKeys = bodyVars?.loop?.map((f) => f.key) ?? [];
    expect(loopKeys).toContain('currentIndex');
    expect(loopKeys).toContain('totalCount');
    expect(loopKeys).toContain('currentItem');
  });

  it('scopes loop variables to the body and aggregate variables to the continuation', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out' },
        { id: 'body', blockType: 'agent', parentId: 'fo' },
        { id: 'report', blockType: 'run_command' },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
        { id: 'e3', source: 'body', target: 'report' },
      ],
    );
    const vars = computeNodeVariables(graph);
    expect(vars.body?.loop?.map((field) => field.key)).toContain('currentItem');
    expect(vars.report?.loop).toBeNull();
    expect(vars.report?.previous.map((field) => field.key)).toEqual(
      expect.arrayContaining(['results', 'totalCount']),
    );
  });

  it('condition passthrough: agent after condition gets run_command fields + result (EC4)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'ag', blockType: 'agent', config: { instructions: '{{previous.exitCode}}' } },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'st', sourceHandle: 'true' },
        { id: 'e4', source: 'cond', target: 'ag', sourceHandle: 'false' },
        { id: 'e5', source: 'st', target: 'ag' },
      ],
    );
    const vars = computeNodeVariables(graph);
    // Node after condition — should see transitive run_command fields + result
    const condVars = vars.ag;
    const prevKeys = condVars?.previous.map((f) => f.key) ?? [];
    expect(prevKeys).toContain('exitCode');
    expect(prevKeys).toContain('result');
  });

  it('double condition passthrough (EC5)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        {
          id: 'c1',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        {
          id: 'c2',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'gt', value: 0 } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.exitCode}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'c1' },
        { id: 'e3', source: 'c1', target: 'c2', sourceHandle: 'true' },
        { id: 'e4', source: 'c1', target: 'rep', sourceHandle: 'false' },
        { id: 'e5', source: 'c2', target: 'rep', sourceHandle: 'true' },
        { id: 'e6', source: 'c2', target: 'rep', sourceHandle: 'false' },
      ],
    );
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    const prevKeys = repVars?.previous.map((f) => f.key) ?? [];
    // Should see run_command fields (transitive) and result (from conditions)
    expect(prevKeys).toContain('exitCode');
    expect(prevKeys).toContain('result');
  });

  it('diamond merge unions schemas from both branches (EC6)', () => {
    // condition → [true: start_task → agent, false: run_command] → chat_reply
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'c',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'reply', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
      ],
      [
        { id: 'e1', source: 't', target: 'c' },
        { id: 'e2', source: 'c', target: 'r', sourceHandle: 'false' },
        { id: 'e3', source: 'c', target: 'st', sourceHandle: 'true' },
        { id: 'e4', source: 'r', target: 'reply' },
        { id: 'e5', source: 'st', target: 'reply' },
      ],
    );
    const vars = computeNodeVariables(graph);
    const replyVars = vars.reply;
    const prevKeys = replyVars?.previous.map((f) => f.key) ?? [];
    // Should have fields from both run_command and start_task
    expect(prevKeys).toContain('exitCode'); // from run_command
    expect(prevKeys).toContain('chatId'); // from start_task
  });

  it('run_command predecessor has dynamic note', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    expect(repVars?.notes.some((n) => n.includes('dynamic'))).toBe(true);
  });

  it('approval skip: node after approval sees upstream fields (EC13)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      { id: 'appr', blockType: 'approval', config: {} },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    const prevKeys = repVars?.previous.map((f) => f.key) ?? [];
    // Should skip approval and see run_command fields
    expect(prevKeys).toContain('exitCode');
  });

  it('http_request predecessor: status, body, headers available', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'h', blockType: 'http_request', config: { url: 'https://example.com' } },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: '{{previous.status}}' } },
    ]);
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    const prevKeys = repVars?.previous.map((f) => f.key) ?? [];
    expect(prevKeys).toContain('status');
    expect(prevKeys).toContain('body');
    expect(prevKeys).toContain('headers');
  });
});

// ---------------------------------------------------------------------------
// validateFlowTemplateVariables
// ---------------------------------------------------------------------------

describe('validateFlowTemplateVariables', () => {
  it('returns no warnings for a valid graph with no templates', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings).toHaveLength(0);
  });

  it('warns when briefing contains unknown {{trigger.*}} for a non-open-ended trigger type', () => {
    // post_task_trigger has a fixed schema — unknown keys in briefing still warn.
    // (manual_trigger accepts arbitrary user-supplied keys so it no longer warns.)
    const graph = {
      ...makeGraph([
        { id: 't', blockType: 'post_task_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
      ]),
      settings: { briefing: 'Task: {{trigger.nonExistentField}}' },
    };
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((x) => x.placeholder === '{{trigger.nonExistentField}}');
    expect(w).toBeDefined();
    expect(w?.field).toBe('briefing');
  });

  it('warns when briefing contains {{previous.unknownField}} for a primary agent', () => {
    const graph = {
      ...makeGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
      ]),
      settings: { briefing: 'Prev result: {{previous.unknownOutput}}' },
    };
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((x) => x.placeholder === '{{previous.unknownOutput}}');
    expect(w).toBeDefined();
    expect(w?.field).toBe('briefing');
  });

  it('briefing is rendered against {{trigger.*}} only — {{previous.*}} and {{flow.*}} warn, valid trigger does not', () => {
    // The briefing is shared across the whole flow and rendered once per run against the trigger
    // context; per-node ({{previous.*}}) and the retired {{flow.*}} scope no longer resolve there.
    const graph = {
      ...makeGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
      ]),
      settings: {
        briefing: 'Ticket {{trigger.ticket}} — prev {{previous.summary}} — self {{flow.briefing}}',
      },
    };
    const warnings = validateFlowTemplateVariables(graph);
    // manual_trigger accepts arbitrary user-supplied keys → the trigger ref is fine.
    expect(warnings.find((w) => w.placeholder === '{{trigger.ticket}}')).toBeUndefined();
    // previous.* and flow.* are unavailable in a once-per-run shared briefing.
    const prevWarn = warnings.find((w) => w.placeholder === '{{previous.summary}}');
    const flowWarn = warnings.find((w) => w.placeholder === '{{flow.briefing}}');
    expect(prevWarn?.field).toBe('briefing');
    expect(prevWarn?.message).toContain('Flow Briefing');
    expect(flowWarn?.field).toBe('briefing');
    expect(flowWarn?.message).toContain('Flow Briefing');
  });

  it('returns no warnings for valid {{previous.exitCode}} reference', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'exit {{previous.exitCode}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings).toHaveLength(0);
  });

  it('warns about unknown {{previous.issues}} on agent node (the real-world bug case)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'Found {{previous.totalFiles}} files with {{previous.issues}} issues.',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const warnedPaths = warnings.map((w) => w.placeholder);
    expect(warnedPaths).toContain('{{previous.totalFiles}}');
    expect(warnedPaths).toContain('{{previous.issues}}');
  });

  it('emits advisory warning for undeclared previous.* fields after run_command (dynamic JSON stdout) (EC7)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'PR count: {{previous.prCount}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.prCount}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('not a declared output field');
    expect(w?.message).toContain('JSON');
  });

  it('does NOT warn about sub-paths of object-typed fields (e.g. headers.content-type)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'h', blockType: 'http_request', config: { url: 'https://example.com' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: '{{previous.headers.content-type}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => w.placeholder !== '{{previous.headers.content-type}}')).toBe(true);
  });

  it('does NOT warn for template in http_request.url (not rendered at runtime) (EC2)', () => {
    // http_request.url is NOT template-rendered — the template variable is invalid at
    // runtime but validate-flow-templates should not check non-rendered fields for
    // known-field validation (only for the "field not rendered" warning).
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      {
        id: 'h',
        blockType: 'http_request',
        config: { url: 'https://example.com/{{previous.status}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // Should warn that http_request.url is not template-rendered, not that 'status' is invalid
    const urlWarning = warnings.find((w) => w.field === 'url');
    expect(urlWarning).toBeDefined();
    expect(urlWarning?.message).toContain('not template-rendered');
  });

  it('custom node string inputs are rendered and still validate previous paths (sc-1597)', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', config: {} },
        {
          id: 'producer',
          blockType: 'run_command',
          config: {
            command: 'echo',
            expectedOutputs: { summary: { type: 'string' } },
          },
        },
        {
          id: 'consumer',
          blockType: 'desk-buddy',
          config: {
            message: '{{previous.summary}} {{previous.missing}}',
            projectId: '{{trigger.projectId}}',
            nested: { literal: '{{previous.summary}}' },
          },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'producer' },
        { id: 'e2', source: 'producer', target: 'consumer' },
      ],
    };

    const warnings = validateFlowTemplateVariables(graph);

    expect(warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'consumer',
          field: 'message',
          placeholder: '{{previous.summary}}',
        }),
      ]),
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'consumer',
          field: 'message',
          placeholder: '{{previous.missing}}',
        }),
      ]),
    );
    expect(warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: 'consumer', field: 'projectId' })]),
    );
    expect(warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: 'consumer', field: 'nested' })]),
    );
  });

  describe('custom node non-flow placeholders (sc-3251)', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', config: {} },
        {
          id: 'cn',
          blockType: 'check-new-prs',
          config: { query: '{"q":"{{field}}"}', note: '{{ name }}', repo: 'org/x' },
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'cn' }],
    };

    it('warns that a non-flow root in a rendered input renders empty, pointing at the opt-out', () => {
      const warnings = validateFlowTemplateVariables(graph);
      const query = warnings.find((w) => w.field === 'query');
      expect(query?.placeholder).toBe('{{field}}');
      expect(query?.message).toContain('"template": false');
      expect(warnings.find((w) => w.field === 'note')?.placeholder).toBe('{{name}}');
    });

    it('stays silent on inputs the manifest opts out', () => {
      const customNodeInputs = new Map([
        ['check-new-prs', { query: { template: false }, note: { template: false } }],
      ]);
      const warnings = validateFlowTemplateVariables(graph, undefined, { customNodeInputs });
      expect(warnings.filter((w) => w.nodeId === 'cn')).toEqual([]);
    });

    it('does not point a plugin node at a manifest opt-out it does not have', () => {
      // Plugin nodes pass isCustomNodeBlockType but have no user manifest, and plugin-node
      // dispatch never reads "template": false — the advice would send the author nowhere.
      const pluginGraph = {
        nodes: [
          { id: 't', blockType: 'manual_trigger', config: {} },
          { id: 'sc', blockType: 'shortcut_create_story', config: { name: 'Fix {{field}}' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'sc' }],
      };
      const warning = validateFlowTemplateVariables(pluginGraph).find((w) => w.field === 'name');
      expect(warning?.placeholder).toBe('{{field}}');
      expect(warning?.message).toContain('empty');
      expect(warning?.message).not.toContain('"template": false');
    });

    it('warns when an opted-out input holds a trigger/previous placeholder that will not resolve', () => {
      const optedOut = {
        nodes: [
          { id: 't', blockType: 'manual_trigger', config: {} },
          {
            id: 'cn',
            blockType: 'check-new-prs',
            config: {
              body: '{"repo":"{{trigger.repo}}","prev":"{{previous.x}}","col":"{{field}}"}',
              jinja: '{% for x in xs %}{{ loop.index }}{% endfor %}',
            },
          },
        ],
        edges: [{ id: 'e1', source: 't', target: 'cn' }],
      };
      const customNodeInputs = new Map([
        ['check-new-prs', { body: { template: false }, jinja: { template: false } }],
      ]);
      const warnings = validateFlowTemplateVariables(optedOut, undefined, { customNodeInputs });
      const placeholders = warnings.filter((w) => w.nodeId === 'cn').map((w) => w.placeholder);
      // A flow variable the author likely meant to render reaches the script as literal text.
      expect(placeholders).toEqual(['{{trigger.repo}}', '{{previous.x}}']);
      expect(warnings[0]?.message).toContain('"template": false');
      // The script's own syntax (non-flow roots, Jinja's loop.*) is the point of opting out.
    });

    it('does not warn about non-flow roots in agent instructions', () => {
      const agentGraph = {
        nodes: [
          { id: 't', blockType: 'manual_trigger', config: {} },
          { id: 'ag', blockType: 'agent', config: { instructions: 'Use {{field}} syntax' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'ag' }],
      };
      expect(validateFlowTemplateVariables(agentGraph)).toEqual([]);
    });
  });

  it('warns that run_command.customPath is not template-rendered (EC3)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'r',
        blockType: 'run_command',
        config: {
          command: 'echo hi',
          workingDirectory: 'custom',
          customPath: '{{previous.worktreePath}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const customPathWarning = warnings.find((w) => w.field === 'customPath');
    expect(customPathWarning).toBeDefined();
    expect(customPathWarning?.message).toContain('path traversal');
  });

  it('warns about loop.* outside fan_out body chain (EC10)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'ag', blockType: 'agent', config: { instructions: 'process {{loop.currentItem}}' } },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const loopWarning = warnings.find((w) => w.placeholder === '{{loop.currentItem}}');
    expect(loopWarning).toBeDefined();
    expect(loopWarning?.message).toContain('fan_out body');
  });

  it('no warnings for loop.* inside fan_out body chain (EC9)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        {
          id: 'body',
          blockType: 'agent',
          parentId: 'fo',
          config: { instructions: 'item {{loop.currentItem}} of {{loop.totalCount}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const loopWarnings = warnings.filter((w) => w.placeholder.startsWith('{{loop.'));
    expect(loopWarnings).toHaveLength(0);
  });

  it('warns about unknown loop field (not currentItem/currentIndex/totalCount)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        {
          id: 'body',
          blockType: 'agent',
          parentId: 'fo',
          config: { instructions: 'item {{loop.unknownField}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const loopWarning = warnings.find((w) => w.placeholder === '{{loop.unknownField}}');
    expect(loopWarning).toBeDefined();
  });

  it('no loop warning for {{loop.currentItem.title}} (sub-path is valid)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        {
          id: 'body',
          blockType: 'agent',
          parentId: 'fo',
          config: { instructions: 'process {{loop.currentItem.title}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => !w.placeholder.includes('currentItem.title'))).toBe(true);
  });

  it('warns for unknown trigger field on a non-open-ended trigger type (EC12)', () => {
    // post_task_trigger has a fixed schema — unknown keys still warn.
    // (manual_trigger accepts arbitrary user-supplied keys so it no longer warns.)
    const graph = makeGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'st',
        blockType: 'start_task',
        config: { projectId: 'p1', label: 'flow {{trigger.scheduledAt}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const triggerWarning = warnings.find((w) => w.placeholder === '{{trigger.scheduledAt}}');
    expect(triggerWarning).toBeDefined();
    expect(triggerWarning?.message).toContain('unknown trigger field');
  });

  it('no trigger warning for valid post_task_trigger field (EC11)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'st',
        blockType: 'start_task',
        config: { projectId: 'p1', label: 'task {{trigger.result}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => !w.placeholder.includes('trigger.result'))).toBe(true);
  });

  it('warns about unknown post_task_trigger field', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'st',
        blockType: 'start_task',
        config: { projectId: 'p1', label: '{{trigger.taskOutput}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // taskOutput is NOT in TRIGGER_SCHEMAS.post_task_trigger — use {{trigger.result}} instead
    const warn = warnings.find((w) => w.placeholder === '{{trigger.taskOutput}}');
    expect(warn).toBeDefined();
  });

  it('warns about previous.* with no predecessor at all', () => {
    // Orphan node — can happen mid-edit
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'ag', blockType: 'agent', config: { instructions: '{{previous.exitCode}}' } },
      ],
      edges: [],
    };
    const warnings = validateFlowTemplateVariables(graph);
    const prevWarning = warnings.find((w) => w.placeholder === '{{previous.exitCode}}');
    expect(prevWarning).toBeDefined();
  });

  it('custom node without declared outputs: advisory warning for undeclared field (EC8)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'custom', blockType: 'my-custom-node', config: {} },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: '{{previous.myField}}' } },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.myField}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('not a declared output field');
  });

  it('custom node predecessor: undeclared field wording points at the manifest, not run_command (sc-1501)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'custom', blockType: 'my-custom-node', config: {} },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: '{{previous.otherField}}' },
      },
    ]);
    // The custom node HAS declared outputs (so it's a genuine typo/undeclared-field case,
    // not the "no manifest at all" EC8 case above) — just not this particular field.
    const customMap = new Map<string, OutputFieldSchema[]>([
      ['my-custom-node', [{ key: 'prCount', type: 'number', description: 'x', guaranteed: true }]],
    ]);
    const pre = computeNodeVariables(graph, { customNodeOutputs: customMap });
    const warnings = validateFlowTemplateVariables(graph, pre);
    const w = warnings.find((w) => w.placeholder === '{{previous.otherField}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('manifest');
    expect(w?.message).toContain('frink_register_node');
    expect(w?.message).not.toContain('expectedOutputs');
    expect(w?.message).not.toContain('run_command');
  });

  it('plugin node predecessor: wording names the catalog, never the manifest edit (sc-2508)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'clickup', blockType: 'clickup_create_task', config: {} },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: '{{previous.nope}}' } },
    ]);
    // A plugin node's blockType satisfies the custom-node grammar, so without the plugin arm
    // this lands on the manifest advice — which is a no-op for a machine-generated manifest.
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.nope}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('plugin catalog');
    expect(w?.message).toContain('clickup');
    expect(w?.message).not.toContain('frink_register_node');
    expect(w?.message).not.toContain('expectedOutputs');
    expect(w?.message).not.toContain('prints JSON');
  });

  it('plugin node with no catalog outputs does not inherit run_command’s exitCode/_rawStdout (sc-2508)', () => {
    // shortcut.create_story and two siblings declare no catalog outputs, so their nodes reach the
    // custom-node fallback — run_command's, whose exitCode a plugin node can never produce.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'sc', blockType: 'shortcut_create_story', config: {} },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: '{{previous.exitCode}}' } },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.exitCode}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('plugin catalog');
    // The declared set must be empty rather than the two run_command fields.
    expect(w?.message).toContain('Declared: (none)');
  });

  it('multi-predecessor (diamond) undeclared field: keeps the generic run_command wording, no attribution guess', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
        {
          id: 'r',
          blockType: 'run_command',
          config: { command: 'echo hi', projectId: 'p1' },
          position: { x: 0, y: 1 },
        },
        { id: 'custom', blockType: 'my-custom-node', config: {}, position: { x: 1, y: 1 } },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.mysteryField}}' },
          position: { x: 0, y: 2 },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 't', target: 'custom' },
        { id: 'e3', source: 'r', target: 'rep' },
        { id: 'e4', source: 'custom', target: 'rep' },
      ],
    };
    // Declare a manifest schema for the custom node so this exercises "ambiguous predecessor
    // WITH a declared custom schema still gets generic wording", not just "no schema at all".
    const customNodeOutputs = new Map<string, OutputFieldSchema[]>([
      ['my-custom-node', [{ key: 'prCount', type: 'number', description: 'x', guaranteed: true }]],
    ]);
    const nodeVariables = computeNodeVariables(graph, { customNodeOutputs });
    const warnings = validateFlowTemplateVariables(graph, nodeVariables);
    const w = warnings.find((w) => w.placeholder === '{{previous.mysteryField}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('expectedOutputs');
    expect(w?.message).not.toContain('frink_register_node');
  });

  it('precomputed computeNodeVariables with customNodeOutputs validates manifest-declared previous.* fields', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c', blockType: 'manifested-custom', config: {} },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: '{{previous.fromManifest}}' },
      },
    ]);
    const withoutManifest = validateFlowTemplateVariables(graph);
    expect(withoutManifest.some((w) => w.placeholder === '{{previous.fromManifest}}')).toBe(true);

    const customMap = new Map<string, OutputFieldSchema[]>([
      [
        'manifested-custom',
        [
          {
            key: 'fromManifest',
            type: 'string',
            description: 'Declared in custom node manifest',
            guaranteed: true,
          },
        ],
      ],
    ]);
    const pre = computeNodeVariables(graph, { customNodeOutputs: customMap });
    const withManifest = validateFlowTemplateVariables(graph, pre);
    expect(withManifest.every((w) => w.placeholder !== '{{previous.fromManifest}}')).toBe(true);
  });

  it('condition passthrough: valid {{previous.exitCode}} after condition is not warned (EC4)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'ag', blockType: 'agent', config: { instructions: '{{previous.exitCode}}' } },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'st', sourceHandle: 'true' },
        { id: 'e4', source: 'cond', target: 'ag', sourceHandle: 'false' },
        { id: 'e5', source: 'st', target: 'ag' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => w.placeholder !== '{{previous.exitCode}}')).toBe(true);
  });

  it('custom node behind a condition: undeclared field still attributes to the manifest, not run_command (sc-1501)', () => {
    // The attribution walk mirrors hasDynamic's own walk (resolveEffectivePredecessorSchema),
    // so a condition pass-through does not break attribution to the real dynamic source.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'custom', blockType: 'my-custom-node', config: {} },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.mysteryField}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'custom' },
        { id: 'e2', source: 'custom', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'rep', sourceHandle: 'true' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.mysteryField}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('frink_register_node');
    expect(w?.message).not.toContain('expectedOutputs');
  });

  it('plugin node behind a condition: attribution survives the passthrough, and the condition’s own field stays valid (sc-2508)', () => {
    const customMap = new Map<string, OutputFieldSchema[]>([
      ['clickup_create_task', [{ key: 'ts', type: 'string', description: 'x', guaranteed: true }]],
    ]);
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'clickup', blockType: 'clickup_create_task', config: {} },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'ts', operator: 'eq', value: '1' } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.result}} {{previous.ts}} {{previous.nope}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'clickup' },
        { id: 'e2', source: 'clickup', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'rep', sourceHandle: 'true' },
      ],
    );
    const pre = computeNodeVariables(graph, { customNodeOutputs: customMap });
    const warnings = validateFlowTemplateVariables(graph, pre);
    // A condition spreads its predecessor's outputs and adds `result`; both must stay valid
    // through the plugin branch, which short-circuits before the generic wording.
    expect(warnings.map((w) => w.placeholder)).not.toContain('{{previous.result}}');
    expect(warnings.map((w) => w.placeholder)).not.toContain('{{previous.ts}}');
    const w = warnings.find((w) => w.placeholder === '{{previous.nope}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('plugin catalog');
    expect(w?.message).not.toContain('frink_register_node');
  });

  it('sc-634 Fix1: no warning for arbitrary {{trigger.ticketId}} on manual_trigger (open-ended context)', () => {
    // manual_trigger accepts user-supplied triggerContext keys at runtime.
    // TRIGGER_ALLOWS_ARBITRARY_KEYS suppresses unknown-field warnings for it.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'Working on {{trigger.ticketId}} in stream {{trigger.workstreamId}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => !w.placeholder.includes('trigger.ticketId'))).toBe(true);
    expect(warnings.every((w) => !w.placeholder.includes('trigger.workstreamId'))).toBe(true);
  });

  it('sc-634 Fix2: no "field not rendered" warning for templates in agentInstructions (Role field)', () => {
    // agentInstructions is rendered at runtime by dispatchAgent for primary agents.
    // Adding it to TEMPLATE_RENDERED_FIELDS suppresses false "not rendered" warnings.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'r',
        blockType: 'run_command',
        config: { command: 'echo hi', projectId: 'p1' },
      },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'Process this.',
          agentInstructions: 'You are a reviewer. Exit code: {{previous.exitCode}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // Should not warn that agentInstructions is "not template-rendered"
    const notRenderedWarn = warnings.find(
      (w) => w.field === 'agentInstructions' && w.message.includes('not template-rendered'),
    );
    expect(notRenderedWarn).toBeUndefined();
    // Should also not warn about {{previous.exitCode}} since run_command declares it
    expect(warnings.every((w) => w.placeholder !== '{{previous.exitCode}}')).toBe(true);
  });

  it('EC4: continuation agent agentInstructions — no "not template-rendered" warning, but templates still validated', () => {
    // agentInstructions is in TEMPLATE_RENDERED_FIELDS so the validator checks it.
    // At runtime, continuation agents' agentInstructions is silently discarded
    // (renderedInstructions = renderedNodeInstructions only, node-dispatch.ts ~1257-1259).
    // This confirms: (1) no "not rendered" false-positive, (2) template paths are still
    // checked so invalid references produce accurate warnings rather than being silently ignored.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
        {
          id: 'a2',
          blockType: 'agent',
          config: {
            instructions: 'continue',
            agentInstructions: 'You are reviewer. {{previous.unknownContinuationField}}',
          },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a1' },
        { id: 'e3', source: 'a1', target: 'a2' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    // No "field not rendered" for agentInstructions
    const notRenderedWarn = warnings.find(
      (w) => w.field === 'agentInstructions' && w.message.includes('not template-rendered'),
    );
    expect(notRenderedWarn).toBeUndefined();
    // Templates ARE validated — unknown previous field still warns
    const prevWarn = warnings.find(
      (w) => w.placeholder === '{{previous.unknownContinuationField}}',
    );
    expect(prevWarn).toBeDefined();
    expect(prevWarn?.field).toBe('agentInstructions');
  });

  it('EC5: agentInstructions with {{flow.briefing}} — no warning on any agent (validator is permissive for flow scope on agent blocks)', () => {
    // The validator only warns for {{flow.*}} when blockType is NOT 'agent'.
    // It does not distinguish primary from continuation for the flow scope warning path
    // (line ~626 in validate-flow-templates.ts). So {{flow.briefing}} in agentInstructions
    // on any agent block — primary or continuation — produces no warning.
    // This is consistent with how {{flow.briefing}} in 'instructions' behaves.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'do work',
          agentInstructions: 'Context: {{flow.briefing}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // No warning for flow.briefing in agentInstructions — consistent with instructions field
    const flowWarn = warnings.find((w) => w.placeholder === '{{flow.briefing}}');
    expect(flowWarn).toBeUndefined();
  });

  it('EC5b: continuation agent agentInstructions with {{flow.briefing}} — no warning', () => {
    // Continuation agent (a2 after a1): computeNodeVariables exposes flow.briefing on a2 only
    // (see "flow.briefing available only for continuation agents"). Validator must not warn for
    // {{flow.briefing}} in agentInstructions on that path — same assertion pattern as EC5.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'first' } },
        {
          id: 'a2',
          blockType: 'agent',
          config: {
            instructions: 'continue',
            agentInstructions: 'Context: {{flow.briefing}}',
          },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a1' },
        { id: 'e3', source: 'a1', target: 'a2' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const flowWarn = warnings.find((w) => w.placeholder === '{{flow.briefing}}');
    expect(flowWarn).toBeUndefined();
  });

  it('EC5c: continuation agent instructions with {{flow.briefing}} — no warning', () => {
    // EC5b covers agentInstructions on a continuation; primary agents use `instructions` for the
    // main prompt. Ensure the same graph shape does not warn when {{flow.briefing}} appears only
    // in `instructions` on a2 (runtime has flow scope there per computeNodeVariables).
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a1', blockType: 'agent', config: { instructions: 'first' } },
        {
          id: 'a2',
          blockType: 'agent',
          config: { instructions: 'Continue using briefing: {{flow.briefing}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a1' },
        { id: 'e3', source: 'a1', target: 'a2' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const flowWarn = warnings.find((w) => w.placeholder === '{{flow.briefing}}');
    expect(flowWarn).toBeUndefined();
  });

  it('EC6: agentInstructions with {{previous.unknownField}} — warns about unknown field, not "not rendered"', () => {
    // Before sc-634: "field not rendered" for the whole agentInstructions field.
    // After sc-634: more precise "unknown previous field" warning for the placeholder.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'do work',
          agentInstructions: 'Status: {{previous.nonExistentOutput}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // Must NOT produce a "not template-rendered" warning for agentInstructions
    const notRenderedWarn = warnings.find(
      (w) => w.field === 'agentInstructions' && w.message.includes('not template-rendered'),
    );
    expect(notRenderedWarn).toBeUndefined();
    // Must produce an "unknown previous" warning for the specific placeholder
    const prevWarn = warnings.find((w) => w.placeholder === '{{previous.nonExistentOutput}}');
    expect(prevWarn).toBeDefined();
    expect(prevWarn?.field).toBe('agentInstructions');
  });

  it('start_task.branch template: valid trigger field not warned', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'st',
        blockType: 'start_task',
        config: { projectId: 'p1', startInWorktree: true, branch: '{{trigger.branch}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => w.placeholder !== '{{trigger.branch}}')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge case: approval skip in warnings path
  // ---------------------------------------------------------------------------

  it('no warning for {{previous.exitCode}} after approval chain (EC13 — warnings path)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      { id: 'appr', blockType: 'approval', config: {} },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'exit {{previous.exitCode}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // Approval has no outputs — skips to run_command. run_command has hasDynamic=true so no warns.
    expect(warnings.every((w) => w.placeholder !== '{{previous.exitCode}}')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge case: double condition passthrough — no false positive warnings
  // ---------------------------------------------------------------------------

  it('no warning for {{previous.exitCode}} after two chained conditions (EC5 — warnings path)', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        {
          id: 'c1',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        {
          id: 'c2',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'gt', value: 0 } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.exitCode}} {{previous.result}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'c1' },
        { id: 'e3', source: 'c1', target: 'c2', sourceHandle: 'true' },
        { id: 'e4', source: 'c1', target: 'rep', sourceHandle: 'false' },
        { id: 'e5', source: 'c2', target: 'rep', sourceHandle: 'true' },
        { id: 'e6', source: 'c2', target: 'rep', sourceHandle: 'false' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    // exitCode and result are both declared fields — no warnings despite dynamic upstream
    const prevWarnings = warnings.filter((w) => w.placeholder.startsWith('{{previous.'));
    expect(prevWarnings).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Edge case: webhook trigger sub-path
  // ---------------------------------------------------------------------------

  it('no warning for {{trigger.payload.repoName}} on webhook_trigger (object sub-path)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'webhook_trigger' },
      {
        id: 'ag',
        blockType: 'agent',
        config: {
          instructions: 'process repo {{trigger.payload.repoName}} event {{trigger.event}}',
        },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => !w.placeholder.includes('trigger.payload'))).toBe(true);
    expect(warnings.every((w) => w.placeholder !== '{{trigger.event}}')).toBe(true);
  });

  it('warns for unknown field on webhook_trigger (not event or payload)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'webhook_trigger' },
      {
        id: 'ag',
        blockType: 'agent',
        config: { instructions: 'repo: {{trigger.repository}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{trigger.repository}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('trigger.event');
  });

  it('does not warn on a friendly alias namespace; still warns on a real typo (no provider context)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'webhook_trigger' },
      {
        id: 'ag',
        blockType: 'agent',
        config: { instructions: 'A: {{trigger.story.title}}\nB: {{trigger.bogusfield}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    // 'story' is a known alias namespace → no warn even without provider context.
    expect(warnings.some((w) => w.placeholder === '{{trigger.story.title}}')).toBe(false);
    // 'bogusfield' matches no envelope field nor alias namespace → still flagged.
    expect(warnings.some((w) => w.placeholder === '{{trigger.bogusfield}}')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge case: empty graph robustness
  // ---------------------------------------------------------------------------

  it('empty graph (no nodes, no edges) returns no warnings without crashing', () => {
    const graph: FlowGraph = { nodes: [], edges: [] };
    expect(() => validateFlowTemplateVariables(graph)).not.toThrow();
    expect(validateFlowTemplateVariables(graph)).toHaveLength(0);
  });

  it('empty graph computeNodeVariables returns empty object without crashing', () => {
    const graph: FlowGraph = { nodes: [], edges: [] };
    expect(() => computeNodeVariables(graph)).not.toThrow();
    expect(Object.keys(computeNodeVariables(graph))).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Edge case: node directly after trigger referencing previous.*
  // ---------------------------------------------------------------------------

  it('warns for {{previous.*}} on node directly after trigger (trigger has no outputs)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'ag',
        blockType: 'agent',
        config: { instructions: 'do something with {{previous.chatId}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const prevWarn = warnings.find((w) => w.placeholder === '{{previous.chatId}}');
    expect(prevWarn).toBeDefined();
    expect(prevWarn?.message).toContain('Available');
  });

  it('no warning for {{trigger.scheduledAt}} on node after schedule_trigger', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'schedule_trigger' },
      {
        id: 'ag',
        blockType: 'agent',
        config: { instructions: 'running at {{trigger.scheduledAt}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => w.placeholder !== '{{trigger.scheduledAt}}')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge case: http_request before chat_reply — declared schema fields validated
  // ---------------------------------------------------------------------------

  it('no warning for {{previous.status}} and {{previous.body}} after http_request', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'h', blockType: 'http_request', config: { url: 'https://example.com' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'status {{previous.status}} body {{previous.body}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    expect(warnings.every((w) => w.placeholder !== '{{previous.status}}')).toBe(true);
    expect(warnings.every((w) => w.placeholder !== '{{previous.body}}')).toBe(true);
  });

  it('warns for unknown field after http_request (not status/body/headers)', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'h', blockType: 'http_request', config: { url: 'https://example.com' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: '{{previous.responseCode}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.responseCode}}');
    expect(w).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// expectedOutputs
// ---------------------------------------------------------------------------

describe('expectedOutputs on run_command', () => {
  const EXPECTED_OUTPUTS: RunCommandExpectedOutputs = {
    timestamp: { type: 'string', description: 'ISO timestamp' },
    message: { type: 'string', description: 'Status message' },
  };

  it('computeNodeVariables: declared fields visible as previous.* for downstream node', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'r',
        blockType: 'run_command',
        config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
      },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const vars = computeNodeVariables(graph);
    const repVars = vars.rep;
    const prevKeys = repVars?.previous.map((f) => f.key) ?? [];
    expect(prevKeys).toContain('exitCode');
    expect(prevKeys).toContain('timestamp');
    expect(prevKeys).toContain('message');
  });

  it('computeNodeVariables: no dynamic note when expectedOutputs declared', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'r',
        blockType: 'run_command',
        config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
      },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.rep?.notes.some((n) => n.includes('dynamic'))).toBe(false);
  });

  it('computeNodeVariables: dynamic note still present when no expectedOutputs', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const vars = computeNodeVariables(graph);
    expect(vars.rep?.notes.some((n) => n.includes('dynamic'))).toBe(true);
  });

  it('computeNodeVariables: customNodeOutputs map enriches custom node predecessor schema', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c', blockType: 'my-script-node', config: {} },
      { id: 'ag', blockType: 'agent', config: { instructions: 'x' } },
    ]);
    const without = computeNodeVariables(graph);
    const fallbackKeys = without.ag?.previous.map((f) => f.key) ?? [];
    expect(fallbackKeys).toContain('exitCode');

    const customMap = new Map([
      [
        'my-script-node',
        [
          {
            key: 'prCount',
            type: 'number' as const,
            description: 'PR count',
            guaranteed: true,
          },
        ],
      ],
    ]);
    const enriched = computeNodeVariables(graph, { customNodeOutputs: customMap });
    const keys = enriched.ag?.previous.map((f) => f.key) ?? [];
    expect(keys).toContain('prCount');
    expect(keys).not.toContain('exitCode');
  });

  it('computeNodeVariables: customNodeOutputs empty array falls back to generic custom schema', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c', blockType: 'empty-manifest-node', config: {} },
      { id: 'ag', blockType: 'agent', config: { instructions: 'x' } },
    ]);
    const map = new Map<string, OutputFieldSchema[]>([['empty-manifest-node', []]]);
    const vars = computeNodeVariables(graph, { customNodeOutputs: map });
    const keys = vars.ag?.previous.map((f) => f.key) ?? [];
    expect(keys).toContain('exitCode');
  });

  it('no warning for declared {{previous.timestamp}} after run_command with expectedOutputs', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'r',
        blockType: 'run_command',
        config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
      },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'ts: {{previous.timestamp}} msg: {{previous.message}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const prev = warnings.filter((w) => w.placeholder.startsWith('{{previous.'));
    expect(prev).toHaveLength(0);
  });

  it('warns for undeclared {{previous.unknown}} when expectedOutputs is declared', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      {
        id: 'r',
        blockType: 'run_command',
        config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
      },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: '{{previous.unknown}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.unknown}}');
    expect(w).toBeDefined();
    expect(w?.message).toContain('unknown output field');
  });

  it('condition passthrough with expectedOutputs: declared fields available after condition', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'r',
          blockType: 'run_command',
          config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
        },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: {
            messageTemplate: '{{previous.timestamp}} {{previous.message}} {{previous.result}}',
          },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'rep', sourceHandle: 'true' },
        { id: 'e4', source: 'cond', target: 'rep', sourceHandle: 'false' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const prev = warnings.filter((w) => w.placeholder.startsWith('{{previous.'));
    expect(prev).toHaveLength(0);
  });

  it('warns for undeclared field after condition → run_command with expectedOutputs', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'r',
          blockType: 'run_command',
          config: { command: 'echo hi', projectId: 'p1', expectedOutputs: EXPECTED_OUTPUTS },
        },
        {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
        },
        {
          id: 'rep',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.notDeclared}}' },
        },
      ],
      [
        { id: 'e1', source: 't', target: 'r' },
        { id: 'e2', source: 'r', target: 'cond' },
        { id: 'e3', source: 'cond', target: 'rep', sourceHandle: 'true' },
        { id: 'e4', source: 'cond', target: 'rep', sourceHandle: 'false' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);
    const w = warnings.find((w) => w.placeholder === '{{previous.notDeclared}}');
    expect(w).toBeDefined();
  });

  it('undeclared field after run_command warns on the referencing node, naming the key', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'ts: {{previous.timestamp}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);

    // The warning belongs to the node holding the unresolvable reference, and tells the author
    // which key to declare and where.
    const w = warnings.find((w) => w.placeholder === '{{previous.timestamp}}');
    expect(w?.nodeId).toBe('rep');
    expect(w?.message).toContain('timestamp');
    expect(w?.message).toContain('expectedOutputs');

    // The producing run_command is never warned about separately — one root fact, one warning.
    expect(warnings.filter((w) => w.field === 'expectedOutputs')).toHaveLength(0);
  });

  it('no warning when run_command has no downstream template references', () => {
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
      { id: 'rep', blockType: 'chat_reply', config: { messageTemplate: 'no vars here' } },
    ]);
    expect(validateFlowTemplateVariables(graph)).toHaveLength(0);
  });

  it('no warning when the key resolves through a merged predecessor schema', () => {
    // A node reachable from both a fan_out and its body chain sees the union of both schemas.
    // `totalCount` comes from the fan_out, so the body run_command has nothing to declare.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'list',
          blockType: 'run_command',
          config: {
            command: 'ls',
            projectId: 'p1',
            expectedOutputs: { items: { type: 'array' } },
          },
        },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        { id: 'body', blockType: 'run_command', config: { command: 'echo work', projectId: 'p1' } },
        {
          id: 'report',
          blockType: 'chat_reply',
          config: { messageTemplate: 'done: {{previous.totalCount}}' },
        },
      ],
      [
        { id: 'e0', source: 't', target: 'list' },
        { id: 'e1', source: 'list', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
        { id: 'e3', source: 'fo', target: 'report' },
        { id: 'e4', source: 'body', target: 'report' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);

    expect(warnings.filter((w) => w.nodeId === 'body')).toHaveLength(0);
    expect(warnings.filter((w) => w.placeholder === '{{previous.totalCount}}')).toHaveLength(0);
  });

  it('undeclared field still warns when an approval node sits between producer and consumer', () => {
    // Approval produces no outputs, so the schema walk continues past it to the run_command.
    // The reference is two hops from its producer — a direct-downstream-only check cannot see it.
    const graph = makeGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'r', blockType: 'run_command', config: { command: 'build', projectId: 'p1' } },
      { id: 'ap', blockType: 'approval', config: { message: 'ship it?' } },
      {
        id: 'rep',
        blockType: 'chat_reply',
        config: { messageTemplate: 'build {{previous.buildId}}' },
      },
    ]);
    const warnings = validateFlowTemplateVariables(graph);

    const w = warnings.find((w) => w.placeholder === '{{previous.buildId}}');
    expect(w?.nodeId).toBe('rep');
    expect(w?.message).toContain('buildId');
    // Attribution survives the approval hop and still points at the run_command.
    expect(w?.message).toContain('expectedOutputs');
    expect(warnings.filter((w) => w.nodeId === 'r')).toHaveLength(0);
  });

  it('two consumers of one producer each get a warning naming their own key', () => {
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi', projectId: 'p1' } },
        { id: 'rep1', blockType: 'chat_reply', config: { messageTemplate: '{{previous.alpha}}' } },
        { id: 'rep2', blockType: 'chat_reply', config: { messageTemplate: '{{previous.beta}}' } },
      ],
      [
        { id: 'e0', source: 't', target: 'r' },
        { id: 'e1', source: 'r', target: 'rep1' },
        { id: 'e2', source: 'r', target: 'rep2' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);

    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.nodeId === 'rep1')?.message).toContain('alpha');
    expect(warnings.find((w) => w.nodeId === 'rep2')?.message).toContain('beta');
  });

  it('fan_out merge shape: a key no predecessor supplies still warns, once, on the consumer', () => {
    // Counterpart to the resolving case above — guards against suppressing the true positive.
    const graph = makeGraph(
      [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'list',
          blockType: 'run_command',
          config: {
            command: 'ls',
            projectId: 'p1',
            expectedOutputs: { items: { type: 'array' } },
          },
        },
        { id: 'fo', blockType: 'fan_out', config: { arrayField: 'items' } },
        { id: 'body', blockType: 'run_command', config: { command: 'echo work', projectId: 'p1' } },
        {
          id: 'report',
          blockType: 'chat_reply',
          config: { messageTemplate: '{{previous.passCount}} passed' },
        },
      ],
      [
        { id: 'e0', source: 't', target: 'list' },
        { id: 'e1', source: 'list', target: 'fo' },
        { id: 'e2', source: 'fo', target: 'body' },
        { id: 'e3', source: 'fo', target: 'report' },
        { id: 'e4', source: 'body', target: 'report' },
      ],
    );
    const warnings = validateFlowTemplateVariables(graph);

    expect(warnings.filter((w) => w.placeholder === '{{previous.passCount}}')).toHaveLength(1);
    expect(warnings.find((w) => w.placeholder === '{{previous.passCount}}')?.nodeId).toBe('report');
    expect(warnings.filter((w) => w.nodeId === 'body')).toHaveLength(0);
  });

  it('resolveRunCommandOutputSchema includes exitCode plus declared fields', () => {
    const schema = resolveRunCommandOutputSchema(EXPECTED_OUTPUTS);
    const keys = schema.map((f) => f.key);
    expect(keys).toContain('exitCode');
    expect(keys).toContain('timestamp');
    expect(keys).toContain('message');
  });
});

describe('computeNodeVariables — webhook friendly aliases', () => {
  const graph = makeGraph([
    { id: 't', blockType: 'webhook_trigger', config: { integrationId: 'i1', eventType: 'x' } },
    { id: 's', blockType: 'start_task', config: { projectId: 'p1' } },
    { id: 'a', blockType: 'agent', config: { instructions: 'go' } },
  ]);

  it('injects the provider aliases as known trigger fields when a provider is given', () => {
    const keys = computeNodeVariables(graph, { webhookProvider: 'shortcut' }).a?.trigger.map(
      (f) => f.key,
    );
    expect(keys).toContain('story.title');
    expect(keys).toContain('payload'); // envelope field retained
    expect(keys).not.toContain('sourceAccountName'); // removed stale field
  });

  it('omits aliases when no provider hint (static/MCP context)', () => {
    const keys = computeNodeVariables(graph).a?.trigger.map((f) => f.key) ?? [];
    expect(keys).not.toContain('story.title');
    expect(keys).toContain('payload');
  });
});
