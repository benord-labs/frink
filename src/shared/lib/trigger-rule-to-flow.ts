import { defaultWebhookAssignee } from './webhook-trigger-condition-pack';
import type { FlowEdge, FlowGraph, FlowNode } from './validate-flow-graph';

/** The seeded draft carries no provider, so the events flagged `assignee` on their EventSpec are named here. */
const WEBHOOK_EVENTS_WITH_ASSIGNEE_FILTER = new Set(['story_assigned', 'story_created']);

export type TriggerFlowSeed = {
  name: string;
  integration_id: string;
  event_type: string;
};

type WebhookTriggerSeedConfig = {
  integrationId: string;
  eventType: string;
  conditions?: { assignee: 'me' | 'anyone' };
};

export type TriggerRuleToFlowResult = {
  /** Suggested flow name (derived from the trigger name). */
  name: string;
  graph: FlowGraph;
};

/** Seeds the "Use in Flow" editor draft: webhook_trigger → start_task → agent → end; project, model and instructions stay for the user to fill in. */
export function triggerRuleToFlow(rule: TriggerFlowSeed): TriggerRuleToFlowResult {
  const TRIGGER_ID = 'trigger-1';
  const START_TASK_ID = 'start-1';
  const AGENT_ID = 'agent-1';
  const END_ID = 'end-1';

  const triggerConfig: WebhookTriggerSeedConfig = {
    integrationId: rule.integration_id,
    eventType: rule.event_type,
  };
  if (WEBHOOK_EVENTS_WITH_ASSIGNEE_FILTER.has(rule.event_type)) {
    triggerConfig.conditions = { assignee: defaultWebhookAssignee(rule.event_type) };
  }

  const nodes: FlowNode[] = [
    {
      id: TRIGGER_ID,
      blockType: 'webhook_trigger',
      label: 'Webhook Trigger',
      config: triggerConfig,
      position: { x: 0, y: 0 },
    },
    {
      id: START_TASK_ID,
      blockType: 'start_task',
      label: 'Start Task',
      config: { startInWorktree: true },
      position: { x: 0, y: 160 },
    },
    {
      id: AGENT_ID,
      blockType: 'agent',
      label: 'Agent',
      config: { instructions: '' },
      position: { x: 0, y: 320 },
    },
    { id: END_ID, blockType: 'end', label: 'End', position: { x: 0, y: 480 } },
  ];

  const edges: FlowEdge[] = [
    { id: 'e-trigger-start', source: TRIGGER_ID, target: START_TASK_ID },
    { id: 'e-start-agent', source: START_TASK_ID, target: AGENT_ID },
    { id: 'e-agent-end', source: AGENT_ID, target: END_ID },
  ];

  return { name: rule.name.trim(), graph: { nodes, edges } };
}
