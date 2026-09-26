/**
 * Ghost Run — edge cases beyond the happy-path rule coverage in index.test.ts.
 * Boundary shapes, tie-break determinism, multi-finding accounting, per-node status
 * mapping, and multi-flow atom isolation (the multi-pane concurrency concern).
 *
 * Note on providers/OS: the rehearsal is pure graph analysis (node config + topology,
 * string-only) with no provider branch (cursor/claude-code) and no fs/path/OS calls,
 * so there is nothing provider- or OS-specific to test here.
 */
import { describe, expect, it } from 'vitest';
import type {
  CustomNodeInputsByType,
  JsonValue,
  ManifestInputDeclarations,
} from '../../../shared/lib/flows/custom-node-required-inputs';
import type { FlowGraph, FlowNode } from '../../../shared/lib/validate-flow-graph';
import { appStore } from '../jotai-store';
import { analyzeFlow, riskiestNodeId } from './analyze';
import {
  clearRehearsal,
  ghostExecAtomFamily,
  ghostRunHeaderStateAtom,
  rehearseFlow,
} from './index';

/** Build a node with a deliberately malformed `config` (simulates corrupted persisted data). */
function nodeWithConfig(id: string, blockType: string, config: unknown): FlowNode {
  return { id, blockType, config } as unknown as FlowNode;
}

describe('analyzeFlow — boundary shapes', () => {
  it('an empty graph yields no findings and does not throw', () => {
    expect(analyzeFlow({ nodes: [], edges: [] })).toEqual([]);
  });

  it('a lone trigger (no edges) is clean — not flagged unreachable', () => {
    const g: FlowGraph = { nodes: [{ id: 't', blockType: 'manual_trigger' }], edges: [] };
    expect(analyzeFlow(g)).toEqual([]);
  });

  it('surfaces quoted run_command placeholders as advisory template findings', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'cmd',
          blockType: 'run_command',
          config: { command: "echo 'x {{trigger.summary}}'" },
        },
      ],
      edges: [{ id: 'e', source: 't', target: 'cmd' }],
    };

    expect(analyzeFlow(graph)).toContainEqual(
      expect.objectContaining({
        nodeId: 'cmd',
        severity: 'warn',
        rule: 'template.command.{{trigger.summary}}.shell-quote.single',
        fix: 'Leave {{trigger.summary}} bare and quote only the static text around it.',
      }),
    );
  });

  it('assigns distinct rule ids when a quoted placeholder is also unresolvable', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: { command: "echo '{{previous.bad}}'" } },
      ],
      edges: [{ id: 'e', source: 't', target: 'cmd' }],
    };
    const findings = analyzeFlow(graph).filter((finding) =>
      finding.rule.includes('{{previous.bad}}'),
    );
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.rule))).toHaveProperty('size', 2);
  });

  it('assigns distinct rule ids for the same placeholder in both quote contexts', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'cmd',
          blockType: 'run_command',
          config: { command: `echo '{{trigger.summary}}' "{{trigger.summary}}"` },
        },
      ],
      edges: [{ id: 'e', source: 't', target: 'cmd' }],
    };
    const findings = analyzeFlow(graph).filter((finding) => finding.rule.includes('shell-quote'));
    expect(findings.map((finding) => finding.rule).sort()).toEqual([
      'template.command.{{trigger.summary}}.shell-quote.double',
      'template.command.{{trigger.summary}}.shell-quote.single',
    ]);
  });

  it('malformed config (null / array / string / non-string command) is treated as empty, not a crash', () => {
    const variants: unknown[] = [
      null,
      undefined,
      [],
      'oops',
      42,
      { command: 42 },
      { command: '  ' },
    ];
    for (const cfg of variants) {
      const g: FlowGraph = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          nodeWithConfig('cmd', 'run_command', cfg),
        ],
        edges: [{ id: 'e', source: 't', target: 'cmd' }],
      };
      const rules = analyzeFlow(g)
        .filter((f) => f.nodeId === 'cmd')
        .map((f) => f.rule);
      expect(rules).toContain('run_command.missing_command');
    }
  });
});

describe('riskiestNodeId — tie-break is deterministic', () => {
  it('same-severity ties resolve to the lexicographically smallest nodeId (array order independent)', () => {
    // Both run_command nodes are empty → both `error`. 'z-node' is listed FIRST to prove the
    // result is not array-order dependent; the smaller id 'a-node' must win.
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'z-node', blockType: 'run_command', config: {} },
        { id: 'a-node', blockType: 'run_command', config: {} },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'z-node' },
        { id: 'e2', source: 'z-node', target: 'a-node' },
      ],
    };
    expect(riskiestNodeId(analyzeFlow(g))).toBe('a-node');
  });
});

describe('rehearseFlow — finding accounting + status mapping', () => {
  it('a node with multiple findings counts once toward affectedNodeCount but N toward findingCount', async () => {
    // webhook_trigger with empty config emits two errors (missing integration + missing event).
    const g: FlowGraph = {
      nodes: [
        { id: 'wh', blockType: 'webhook_trigger', config: {} },
        { id: 'st', blockType: 'start_task' },
      ],
      edges: [{ id: 'e', source: 'wh', target: 'st' }],
    };
    const states = await rehearseFlow('flow-acct', g);
    expect(states.get('wh')?.findings.length).toBe(2);
    expect(states.get('wh')?.status).toBe('failed');
    const header = appStore.get(ghostRunHeaderStateAtom);
    expect(header?.findingCount).toBe(2);
    expect(header?.affectedNodeCount).toBe(1);
    expect(header?.errorCount).toBe(2);
    expect(header?.nodeCount).toBe(2);
  });

  it('a warn-only node maps to "warn" status and is NOT at-risk when an error node exists', async () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: {} }, // error: missing command
        { id: 'orphan', blockType: 'end' }, // warn: unreachable
      ],
      edges: [{ id: 'e', source: 't', target: 'cmd' }],
    };
    const states = await rehearseFlow('flow-status', g);
    expect(states.get('orphan')?.status).toBe('warn');
    expect(states.get('orphan')?.isAtRisk).toBeUndefined();
    expect(states.get('cmd')?.status).toBe('failed');
    expect(states.get('cmd')?.isAtRisk).toBe(true);
  });
});

describe('rehearseFlow — multi-flow isolation (multi-pane / concurrent rehearsals)', () => {
  it('two flows sharing identical nodeIds do not cross-contaminate ghost atoms', async () => {
    const broken: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'shared', blockType: 'run_command', config: {} },
      ],
      edges: [{ id: 'e', source: 't', target: 'shared' }],
    };
    const healthy: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'shared', blockType: 'run_command', config: { command: 'echo ok' } },
      ],
      edges: [{ id: 'e', source: 't', target: 'shared' }],
    };
    // Interleave the two flows — the per-node atoms are keyed by `${flowId}:${nodeId}`.
    await rehearseFlow('flow-A', broken);
    await rehearseFlow('flow-B', healthy);
    expect(appStore.get(ghostExecAtomFamily('flow-A:shared'))?.status).toBe('failed');
    expect(appStore.get(ghostExecAtomFamily('flow-B:shared'))?.status).toBe('completed');
  });
});

describe('clearRehearsal — only blanks nodes in the passed graph', () => {
  it('a node dropped from the graph keeps its ghost atom (caller must clear with the rehearsed graph)', async () => {
    const full: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cmd', blockType: 'run_command', config: {} },
      ],
      edges: [{ id: 'e', source: 't', target: 'cmd' }],
    };
    await rehearseFlow('flow-clear', full);
    expect(appStore.get(ghostExecAtomFamily('flow-clear:cmd'))).not.toBeNull();

    // The graph shrank (cmd removed) before clear — clear only iterates the passed graph's nodes.
    clearRehearsal('flow-clear', { nodes: [{ id: 't', blockType: 'manual_trigger' }], edges: [] });
    expect(appStore.get(ghostExecAtomFamily('flow-clear:t'))).toBeNull();
    // 'cmd' is not in the passed graph, so its atom is left set — a benign leak gated off by
    // ghostRunActive in the UI. Documents the contract: clear with the graph you rehearsed.
    expect(appStore.get(ghostExecAtomFamily('flow-clear:cmd'))).not.toBeNull();
  });
});

describe('analyzeFlow — remaining rule firings (baseline coverage)', () => {
  const ruleFires = (g: FlowGraph, rule: string) =>
    expect(analyzeFlow(g).some((f) => f.rule === rule)).toBe(true);

  it('run_command with a custom working directory but no path', () => {
    ruleFires(
      {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          {
            id: 'c',
            blockType: 'run_command',
            config: { command: 'echo hi', workingDirectory: 'custom', customPath: '' },
          },
        ],
        edges: [{ id: 'e', source: 't', target: 'c' }],
      },
      'run_command.missing_custom_path',
    );
  });

  it('condition missing the true branch', () => {
    ruleFires(
      {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'cond', blockType: 'condition' },
          { id: 'end', blockType: 'end' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'cond' },
          { id: 'e2', source: 'cond', target: 'end', sourceHandle: 'false' }, // only false branch
        ],
      },
      'condition.missing_true_branch',
    );
  });

  it('chat_reply with an empty message template (warn)', () => {
    ruleFires(
      {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'reply', blockType: 'chat_reply', config: {} },
        ],
        edges: [{ id: 'e', source: 't', target: 'reply' }],
      },
      'chat_reply.empty_message',
    );
  });

  it('unknown block type (neither registered nor custom-pattern)', () => {
    // 'UnknownType' starts uppercase, so it is not a custom-node name and not a built-in.
    ruleFires(
      {
        nodes: [{ id: 't', blockType: 'manual_trigger' }, nodeWithConfig('x', 'UnknownType', {})],
        edges: [{ id: 'e', source: 't', target: 'x' }],
      },
      'node.unknown_block_type',
    );
  });

  it('parameterless custom node is neither unconfigured nor unknown', () => {
    const g: FlowGraph = {
      nodes: [{ id: 't', blockType: 'manual_trigger' }, nodeWithConfig('cn', 'my-custom-node', {})],
      edges: [{ id: 'e', source: 't', target: 'cn' }],
    };
    const rules = analyzeFlow(g).map((f) => f.rule);
    expect(rules).not.toContain('custom_node.unconfigured');
    expect(rules).not.toContain('node.unknown_block_type');
  });
});

describe('analyzeFlow — required custom-node inputs', () => {
  const MANIFEST_KEY = 'my-custom-node';
  const graphWith = (config: Record<string, JsonValue>): FlowGraph => ({
    nodes: [{ id: 't', blockType: 'manual_trigger' }, nodeWithConfig('cn', MANIFEST_KEY, config)],
    edges: [{ id: 'e', source: 't', target: 'cn' }],
  });
  const withManifest = (inputs: ManifestInputDeclarations): CustomNodeInputsByType =>
    new Map([[MANIFEST_KEY, inputs]]);
  const rulesFor = (
    config: Record<string, JsonValue>,
    inputs: ManifestInputDeclarations,
  ): string[] => analyzeFlow(graphWith(config), withManifest(inputs)).map((f) => f.rule);

  it('a manifest declaring no inputs produces no finding', () => {
    expect(rulesFor({}, {})).not.toContain('custom_node.missing_required_input');
  });

  it('a required input with no value and no default is a run-blocking error naming it', () => {
    const findings = analyzeFlow(graphWith({}), withManifest({ repo: { required: true } }));
    const finding = findings.find((f) => f.rule === 'custom_node.missing_required_input');
    expect(finding?.severity).toBe('error');
    expect(finding?.why).toContain('"repo"');
  });

  it('a required input satisfied by config or by a manifest default produces no finding', () => {
    expect(rulesFor({ repo: 'owner/repo' }, { repo: { required: true } })).not.toContain(
      'custom_node.missing_required_input',
    );
    expect(rulesFor({}, { repo: { required: true, default: 'owner/repo' } })).not.toContain(
      'custom_node.missing_required_input',
    );
  });

  it('a templated required value is left to the runtime rather than guessed at', () => {
    expect(rulesFor({ repo: '{{previous.repo}}' }, { repo: { required: true } })).not.toContain(
      'custom_node.missing_required_input',
    );
  });

  it('says nothing while manifests are unknown, so uninstalled nodes are not painted red', () => {
    // NodeHealthBadge owns the "not discovered locally" case; undefined here means "not yet known".
    expect(analyzeFlow(graphWith({})).map((f) => f.rule)).not.toContain(
      'custom_node.missing_required_input',
    );
    expect(analyzeFlow(graphWith({}), new Map()).map((f) => f.rule)).not.toContain(
      'custom_node.missing_required_input',
    );
  });

  it('attributes findings per node when two steps share one manifest', () => {
    // Same block type twice: only the unsatisfied step may be flagged, and the finding must carry
    // that step's own id so the canvas highlights the right one.
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        nodeWithConfig('ok', MANIFEST_KEY, { repo: 'owner/repo' }),
        nodeWithConfig('bad', MANIFEST_KEY, {}),
      ],
      edges: [
        { id: 'e1', source: 't', target: 'ok' },
        { id: 'e2', source: 'ok', target: 'bad' },
      ],
    };
    const missing = analyzeFlow(graph, withManifest({ repo: { required: true } })).filter(
      (f) => f.rule === 'custom_node.missing_required_input',
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.nodeId).toBe('bad');
  });

  it('a manifest for a different node does not spill onto this one', () => {
    const findings = analyzeFlow(
      graphWith({}),
      new Map([['some-other-node', { repo: { required: true } }]]),
    );
    expect(findings.map((f) => f.rule)).not.toContain('custom_node.missing_required_input');
  });

  it('names every missing input on one node in a single finding', () => {
    const findings = analyzeFlow(
      graphWith({}),
      withManifest({ repo: { required: true }, branch: { required: true } }),
    );
    const finding = findings.find((f) => f.rule === 'custom_node.missing_required_input');
    expect(finding?.why).toContain('"repo"');
    expect(finding?.why).toContain('"branch"');
  });

  it('survives a node whose persisted config is malformed rather than an object', () => {
    const findings = analyzeFlow(
      {
        nodes: [{ id: 't', blockType: 'manual_trigger' }, nodeWithConfig('cn', MANIFEST_KEY, null)],
        edges: [{ id: 'e', source: 't', target: 'cn' }],
      },
      withManifest({ repo: { required: true } }),
    );
    expect(findings.map((f) => f.rule)).toContain('custom_node.missing_required_input');
  });

  it('a flow-level default project satisfies a required projectId with no node-local value', () => {
    // SAFETY: graphWith returns a complete FlowGraph; only the optional settings slot is added.
    const graph: FlowGraph = {
      ...graphWith({}),
      settings: { defaultProjectId: 'project-1' },
    } as FlowGraph;
    const rules = analyzeFlow(graph, withManifest({ projectId: { required: true } })).map(
      (f) => f.rule,
    );
    expect(rules).not.toContain('custom_node.missing_required_input');
  });
});

describe('analyzeFlow — validator-parity rules (mirror validateGraph run mode)', () => {
  it('chat_reply with no upstream Start Task / Post-Task trigger is a run-blocking error', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'reply', blockType: 'chat_reply', config: { messageTemplate: 'hi' } },
      ],
      edges: [{ id: 'e', source: 't', target: 'reply' }],
    };
    const f = analyzeFlow(g).find((x) => x.rule === 'chat_reply.no_chat_session');
    expect(f?.severity).toBe('error');
  });

  it('chat_reply downstream of a Start Task is clean (no chat-session error)', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task' },
        { id: 'reply', blockType: 'chat_reply', config: { messageTemplate: 'hi' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'reply' },
      ],
    };
    expect(analyzeFlow(g).some((x) => x.rule === 'chat_reply.no_chat_session')).toBe(false);
  });

  it('condition with a stray third outgoing edge is flagged (exactly-two rule)', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cond', blockType: 'condition' },
        { id: 'a', blockType: 'end' },
        { id: 'b', blockType: 'end' },
        { id: 'c', blockType: 'end' },
      ],
      edges: [
        { id: 'e0', source: 't', target: 'cond' },
        { id: 'e1', source: 'cond', target: 'a', sourceHandle: 'true' },
        { id: 'e2', source: 'cond', target: 'b', sourceHandle: 'false' },
        { id: 'e3', source: 'cond', target: 'c', sourceHandle: 'true' }, // stray third edge
      ],
    };
    expect(analyzeFlow(g).some((x) => x.rule === 'condition.wrong_edge_count')).toBe(true);
  });

  it('run_command with an unrecognised workingDirectory is flagged', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'c',
          blockType: 'run_command',
          config: { command: 'echo hi', workingDirectory: 'bogus' },
        },
      ],
      edges: [{ id: 'e', source: 't', target: 'c' }],
    };
    const f = analyzeFlow(g).find((x) => x.rule === 'run_command.invalid_working_directory');
    expect(f?.severity).toBe('error');
  });

  it('http_request flags a non-http(s) protocol and a malformed URL, but accepts a valid https URL', () => {
    const httpFlow = (url: string): FlowGraph => ({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'h', blockType: 'http_request', config: { url } },
      ],
      edges: [{ id: 'e', source: 't', target: 'h' }],
    });
    expect(
      analyzeFlow(httpFlow('ftp://example.com')).some(
        (f) => f.rule === 'http_request.invalid_protocol',
      ),
    ).toBe(true);
    expect(
      analyzeFlow(httpFlow('not a url')).some((f) => f.rule === 'http_request.invalid_url'),
    ).toBe(true);
    const cleanHttp = analyzeFlow(httpFlow('https://example.com/api')).map((f) => f.rule);
    expect(cleanHttp).not.toContain('http_request.invalid_protocol');
    expect(cleanHttp).not.toContain('http_request.invalid_url');
    expect(cleanHttp).not.toContain('http_request.missing_url');
  });
});
