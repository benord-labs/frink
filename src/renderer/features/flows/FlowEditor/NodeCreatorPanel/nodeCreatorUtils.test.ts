import { describe, expect, it } from 'vitest';
import type { NodeCreatorCategory } from './nodeCreatorCategories';
import { filterNodeCreatorCategories } from './nodeCreatorUtils';

const ALLOWED = new Set(['start_task']);

function cats(): NodeCreatorCategory[] {
  return [
    { id: 'actions', label: 'Actions', types: ['start_task', 'unregistered_block'] },
    { id: 'integrations', label: 'Integrations', types: ['slack_send_message'] },
    { id: 'custom', label: 'Custom', types: ['my-node'] },
  ];
}

describe('filterNodeCreatorCategories', () => {
  it('keeps manifest-backed categories the block registry cannot vouch for', () => {
    // Custom AND integration node types come from local manifests, so the
    // allowed set must only prune registry-backed categories — pruning the
    // integrations category rendered every spawned plugin node invisible.
    expect(filterNodeCreatorCategories(cats(), ALLOWED, '')).toEqual([
      { id: 'actions', label: 'Actions', types: ['start_task'] },
      { id: 'integrations', label: 'Integrations', types: ['slack_send_message'] },
      { id: 'custom', label: 'Custom', types: ['my-node'] },
    ]);
  });

  it('matches integration nodes by type name in search', () => {
    const filtered = filterNodeCreatorCategories(cats(), ALLOWED, 'slack');
    expect(filtered).toEqual([
      { id: 'integrations', label: 'Integrations', types: ['slack_send_message'] },
    ]);
  });
});
