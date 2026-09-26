import { describe, expect, it } from 'vitest';
import type { TriggerFlowSeed } from './trigger-rule-to-flow';
import { triggerRuleToFlow } from './trigger-rule-to-flow';

const BASE_RULE: TriggerFlowSeed = {
  name: 'Story assigned',
  integration_id: 'intg-1',
  event_type: 'story_assigned',
};

describe('triggerRuleToFlow', () => {
  it('produces a 4-node graph: webhook_trigger -> start_task -> agent -> end', () => {
    const { graph } = triggerRuleToFlow(BASE_RULE);
    expect(graph.nodes.map((n) => n.blockType)).toEqual([
      'webhook_trigger',
      'start_task',
      'agent',
      'end',
    ]);
  });

  it('creates edges in the correct order', () => {
    const { graph } = triggerRuleToFlow(BASE_RULE);
    expect(graph.edges.map((e) => [e.source, e.target])).toEqual([
      ['trigger-1', 'start-1'],
      ['start-1', 'agent-1'],
      ['agent-1', 'end-1'],
    ]);
  });

  it('maps integration_id and event_type to webhook_trigger config', () => {
    const { graph } = triggerRuleToFlow(BASE_RULE);
    expect(graph.nodes[0]?.config).toMatchObject({
      integrationId: 'intg-1',
      eventType: 'story_assigned',
    });
  });

  it('leaves project, model and instructions for the user to fill in, isolated by default', () => {
    // Sibling of flow-initial-graph.ts's default scaffold — an unconfigured start_task
    // dispatches with no worktree, so this plugin/webhook-seeded flow must opt in too.
    const { graph } = triggerRuleToFlow(BASE_RULE);
    expect(graph.nodes[1]?.config).toEqual({ startInWorktree: true });
    expect(graph.nodes[2]?.config).toEqual({ instructions: '' });
    expect(graph.settings).toBeUndefined();
  });

  it('uses the trimmed trigger name as the flow name', () => {
    const { name } = triggerRuleToFlow({ ...BASE_RULE, name: '  Story assigned  ' });
    expect(name).toBe('Story assigned');
  });

  it('Shortcut assignment events default to anyone without an account identity', () => {
    const { graph } = triggerRuleToFlow(BASE_RULE);
    expect(graph.nodes[0]?.config?.conditions).toEqual({ assignee: 'anyone' });
  });

  it('other events carry no conditions on the webhook trigger', () => {
    const { graph } = triggerRuleToFlow({ ...BASE_RULE, event_type: 'story_moved' });
    expect(graph.nodes[0]?.config).not.toHaveProperty('conditions');
  });
});
