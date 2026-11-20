/** A Flow an agent edited in place: two saved versions plus the chat receipt of the patch between them. */
import * as schema from '../../../src/main/lib/db/schema';
import type { FlowNode } from '../../../src/shared/lib/validate-flow-graph';
import { FIXTURE_PROJECT_ID, T0, T1, type SqliteDb } from './base';

export const FIXTURE_EDITED_FLOW_ID = 'qa-fixture-flow-edited';

const SHIP_RULES = [
  'Open a pull request for the current branch. Never push to main directly.',
  "Write the PR description from the story's acceptance criteria. Keep it short: what changed, why, and how it was tested.",
  'Link every follow-up story you filed.',
  'Do not merge the PR. Stop once it is open and report the URL.',
];

function graph(version: 1 | 2) {
  const shipRules =
    version === 1
      ? SHIP_RULES
      : SHIP_RULES.map((rule, index) =>
          index === 1
            ? `${rule} If the change touches the UI, attach before and after screenshots to the PR body.`
            : rule,
        );
  const node = (id: string, blockType: string, label: string, config: FlowNode['config']) => ({
    id,
    blockType,
    label,
    config,
    position: { x: 0, y: 0 },
  });
  return {
    nodes: [
      node('trigger', 'manual_trigger', 'Story assigned', {}),
      node('gate', 'condition', 'Project = devkit?', { predicate: 'project == "devkit"' }),
      node('edge', 'agent', 'Edge cases', {
        instructions: `Find the ${version === 1 ? 'egde' : 'edge'} cases this change misses and add a test for each.`,
      }),
      node('ship', 'agent', 'Ship PR', {
        instructions: shipRules.join('\n\n'),
        model: version === 1 ? 'sonnet' : 'opus',
      }),
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'edge', sourceHandle: 'true', label: 'If yes' },
      { id: 'e3', source: 'edge', target: 'ship' },
    ],
    settings: {},
  };
}

export function seedEditedFlowFixture(db: SqliteDb): void {
  db.insert(schema.flows)
    .values({
      id: FIXTURE_EDITED_FLOW_ID,
      projectId: FIXTURE_PROJECT_ID,
      name: 'Ship stories',
      createdAt: T0,
      updatedAt: T1,
    })
    .run();
  db.insert(schema.flowVersions)
    .values(
      [1, 2].map((versionNumber) => ({
        id: `${FIXTURE_EDITED_FLOW_ID}-v${versionNumber}`,
        flowId: FIXTURE_EDITED_FLOW_ID,
        versionNumber,
        graph: graph(versionNumber === 1 ? 1 : 2),
        createdAt: versionNumber === 1 ? T0 : T1,
      })),
    )
    .run();
}

function stepUpdate(operationIndex: number, nodeId: string, label: string, detail: string) {
  return {
    operationIndex,
    action: 'update',
    kind: 'node',
    status: 'applied',
    label,
    detail,
    nodeId,
    blockType: 'agent',
  };
}

const { nodes, edges } = graph(2);

/** The agent's patch from version 1 to 2, as the Flow tool returns it. */
export const FIXTURE_FLOW_EDIT_MESSAGE = {
  id: 'qa-fixture-msg-assistant-flow-edit',
  role: 'assistant',
  parts: [
    {
      type: 'tool-mcp__frink__frink_flows_patch',
      toolCallId: 'qa-flow-patch-edit',
      state: 'output-available',
      input: {
        flowId: FIXTURE_EDITED_FLOW_ID,
        operations: [
          { op: 'update_node', nodeId: 'ship' },
          { op: 'update_node', nodeId: 'edge' },
        ],
      },
      result: {
        status: 'success',
        persistence: 'saved',
        flowId: FIXTURE_EDITED_FLOW_ID,
        name: 'Ship stories',
        versionNumber: 2,
        graph: {
          nodes: nodes.map(({ id, blockType, label }) => ({ id, blockType, label })),
          edges,
        },
        applied: [0, 1],
        failed: [],
        skipped: [],
        flowChange: {
          schemaVersion: 1,
          mode: 'update',
          baseVersionNumber: 1,
          versionNumber: 2,
          changes: [
            stepUpdate(0, 'ship', 'Ship PR', 'Instructions · Model'),
            stepUpdate(1, 'edge', 'Edge cases', 'Instructions'),
          ],
        },
      },
    },
  ],
};
