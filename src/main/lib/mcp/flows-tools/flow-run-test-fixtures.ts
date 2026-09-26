export const invocableFlowFixture = {
  id: '550e8400-e29b-41d4-a716-446655440099',
  name: 'Runnable',
  description: null,
  project_id: null,
  is_enabled: true,
  agent_invocable: true,
  trigger_type: 'manual_trigger',
  node_count: 2,
  latest_version_id: 'ver-1',
  version_number: 1,
  graph: {
    nodes: [
      { id: 't1', blockType: 'manual_trigger' },
      { id: 'st1', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'a1', blockType: 'agent', config: { instructions: 'do work' } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'st1' },
      { id: 'e2', source: 'st1', target: 'a1' },
    ],
  },
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
};
