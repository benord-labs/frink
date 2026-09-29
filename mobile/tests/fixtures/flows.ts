import type {
  MobileFlowDefinition,
  MobileResponses,
  MobileRun,
} from '../../../src/shared/types/remote/mobile';
import { flowFixture, flowsFixture, NOW, runFixture } from './data';

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** A branching Flow with a loop, a join and long instructions (the outline's hard cases). */
export const triageDefinition: MobileFlowDefinition = {
  versionNumber: 4,
  nodes: [
    {
      id: 'trigger',
      label: 'Every weekday at 8:00',
      blockType: 'schedule_trigger',
      parentId: null,
      instructions: null,
    },
    {
      id: 'review',
      label: 'Check incoming issues',
      blockType: 'agent',
      parentId: null,
      instructions:
        'Review new issues and check:\n\n- Is it actionable?\n- Can we reproduce it?\n\nKeep the summary **short and useful**.',
    },
    {
      id: 'decision',
      label: 'Ready to proceed?',
      blockType: 'condition',
      parentId: null,
      instructions: null,
    },
    {
      id: 'prepare',
      label: 'Prepare next steps for the issues that need a detailed investigation',
      blockType: 'agent',
      parentId: null,
      instructions: 'Prepare a concise plan.',
    },
    {
      id: 'summary',
      label: 'Publish summary',
      blockType: 'agent',
      parentId: null,
      instructions: null,
    },
  ],
  edges: [
    { id: 'a', source: 'trigger', target: 'review', label: null, sourceHandle: null },
    { id: 'b', source: 'review', target: 'decision', label: null, sourceHandle: null },
    { id: 'c', source: 'decision', target: 'prepare', label: 'Ready', sourceHandle: 'true' },
    {
      id: 'd',
      source: 'decision',
      target: 'review',
      label: 'Needs changes',
      sourceHandle: 'false',
    },
    { id: 'e', source: 'prepare', target: 'summary', label: null, sourceHandle: null },
    {
      id: 'f',
      source: 'decision',
      target: 'summary',
      label: 'No work needed',
      sourceHandle: 'skip',
    },
  ],
};

/**
 * The Flows list exactly as the Mac sends it: `status` is the live run's display status
 * ("awaiting_input" for a run parked on a decision), while `lastRun` keeps the engine's raw
 * status, which is "paused" for that same run.
 */
export function macFlows(): MobileResponses['flows'] {
  return flowsFixture().map((flow) =>
    flow.lastRun?.status === 'awaiting_input'
      ? { ...flow, lastRun: { ...flow.lastRun, status: 'paused' } }
      : flow,
  );
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** A history row for a Flow's newest run; a finished run took four minutes. */
function runFromLast({ id, status, at }: { id: string; status: string; at: string }) {
  const done = TERMINAL.has(status);
  const startedAt = done ? new Date(Date.parse(at) - 4 * 60_000).toISOString() : at;
  return { id, status, createdAt: startedAt, startedAt, completedAt: done ? at : null };
}

/** The computer's `flow` answer for any fixture Flow, honouring the run window. The newest run
 *  is the Flow's `lastRun`, so the list row, the detail and its history tell one story. */
export function flowFor(id: string, runLimit = 5): MobileResponses['flow'] {
  const flow = macFlows().find((entry) => entry.id === id) ?? macFlows()[0];
  const base = flowFixture();
  const statuses = ['completed', 'completed', 'failed', 'completed', 'cancelled', 'completed'];
  const history = Array.from({ length: 24 }, (_, index) => {
    const start = 60 * 24 * (index + 1) + 17;
    return {
      id: `${id}-run-${index}`,
      status: statuses[index % statuses.length],
      createdAt: ago(start),
      startedAt: ago(start),
      completedAt: ago(start - 3 - (index % 5)),
    };
  });
  const newest = flow.lastRun ? [runFromLast(flow.lastRun)] : [];
  const items = [...newest, ...history];
  return {
    flow,
    definition: id === 'flow-2' ? triageDefinition : base.definition,
    runs: { items: items.slice(0, runLimit), hasMore: items.length > runLimit },
  };
}

/** A paused run waiting on two decisions: an approval step and a plan to approve or skip. */
export function waitingRun(): MobileRun {
  const run = runFixture();
  return {
    ...run,
    id: 'run-3',
    status: 'paused',
    createdAt: ago(15),
    startedAt: ago(15),
    flowId: 'flow-3',
    flowName: 'Release checklist',
    nodes: [
      { ...run.nodes[0], label: 'Started by Benji', completedAt: ago(14) },
      {
        ...run.nodes[1],
        id: 'nr-changelog',
        label: 'Write the changelog',
        status: 'completed',
        detail: 'Wrote **12** entries from merged pull requests.',
        startedAt: ago(14),
        completedAt: ago(11),
      },
      {
        ...run.nodes[2],
        id: 'nr-plan',
        label: 'Plan the announcement',
        status: 'awaiting_input',
        detail:
          '## Announcement plan\n\n1. Post the release notes on the blog\n2. Share a short thread with the top three changes\n3. Email beta testers',
        chatId: 'chat-7',
        subChatId: 'sub-7',
        actions: ['approve', 'skip'],
        actionToken: 'e'.repeat(64),
        startedAt: ago(11),
      },
      { ...run.nodes[3], label: 'Publish the release', status: 'pending' },
    ],
  };
}
