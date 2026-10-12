import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../../../shared/lib/validate-flow-graph';
import { flowNodeNeedsAttention, flowNodeNeedsProject, flowNodeSummaryLine } from './nodeSummary';

function node(partial: Partial<FlowNode> & Pick<FlowNode, 'id' | 'blockType'>): FlowNode {
  return {
    id: partial.id,
    blockType: partial.blockType,
    label: partial.label,
    config: partial.config,
  };
}

describe('flowNodeSummaryLine', () => {
  it('says how a manual trigger starts, never repeating its name', () => {
    expect(
      flowNodeSummaryLine(node({ id: '1', blockType: 'manual_trigger', label: 'Start here' })),
    ).toBe('Runs when you press Run');
  });

  it('summarizes run_command', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'run_command',
          config: { command: 'npm test', projectId: 'p1' },
        }),
      ),
    ).toContain('npm test');
  });

  it('summarizes condition with truthy', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'truthy' } },
        }),
      ),
    ).toBe('If status is truthy');
  });

  it('summarizes http_request with url', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'http_request',
          config: { url: 'https://api.example.com/hook' },
        }),
      ),
    ).toBe('https://api.example.com/hook');
  });

  it('summarizes post_task_trigger with status count', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'post_task_trigger',
          label: 'After task',
          config: { triggerStates: ['done', 'failed'] },
        }),
      ),
    ).toBe('Watches 2 task statuses');
  });

  it('summarizes schedule_trigger with cron snippet', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'schedule_trigger',
          config: { cronExpression: '0 * * * *' },
        }),
      ),
    ).toContain('0 * * * *');
  });
});

describe('flowNodeNeedsAttention', () => {
  describe('agent', () => {
    it('returns true when instructions are missing (empty config)', () => {
      expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'agent', config: {} }))).toBe(true);
    });

    it('returns true when instructions are missing even if model is set', () => {
      expect(
        flowNodeNeedsAttention(node({ id: '1', blockType: 'agent', config: { model: 'x' } })),
      ).toBe(true);
    });

    it('returns false when instructions are set', () => {
      expect(
        flowNodeNeedsAttention(
          node({ id: '1', blockType: 'agent', config: { instructions: 'Do X' } }),
        ),
      ).toBe(false);
    });

    it('returns false when instructions and optional model override are set', () => {
      expect(
        flowNodeNeedsAttention(
          node({
            id: '1',
            blockType: 'agent',
            config: { instructions: 'do it', model: 'fast' },
          }),
        ),
      ).toBe(false);
    });

    it('still returns true without instructions when flow default project is passed', () => {
      expect(
        flowNodeNeedsAttention(
          node({ id: '1', blockType: 'agent', config: {} }),
          'flow-default-project-id',
        ),
      ).toBe(true);
    });

    it('returns false with instructions when flow default project is passed', () => {
      expect(
        flowNodeNeedsAttention(
          node({ id: '1', blockType: 'agent', config: { instructions: 'Do X' } }),
          'flow-default-project-id',
        ),
      ).toBe(false);
    });
  });

  it('flags run_command without command or project', () => {
    expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'run_command', config: {} }))).toBe(
      true,
    );
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'run_command', config: { command: 'x', projectId: 'p' } }),
      ),
    ).toBe(false);
  });

  it('run_command does not flag attention when flow default project fills in', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'run_command', config: { command: 'npm test' } }),
        'flow-default-project-id',
      ),
    ).toBe(false);
  });

  it('run_command still flags attention when neither node nor flow has project', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'run_command', config: { command: 'npm test' } }),
      ),
    ).toBe(true);
  });

  it('flags http_request without url', () => {
    expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'http_request', config: {} }))).toBe(
      true,
    );
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'http_request', config: { url: 'https://x.test' } }),
      ),
    ).toBe(false);
  });

  it('flags condition without field', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: '', operator: 'eq', value: 'a' } },
        }),
      ),
    ).toBe(true);
  });

  it('flags condition with eq operator and empty value', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'eq', value: '' } },
        }),
      ),
    ).toBe(true);
  });

  it('flags condition with neq operator and null value', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'neq', value: null } },
        }),
      ),
    ).toBe(true);
  });

  it('flags condition with contains operator and undefined value', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'contains', value: undefined } },
        }),
      ),
    ).toBe(true);
  });

  it('clears condition with eq operator and non-empty value', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'eq', value: 'done' } },
        }),
      ),
    ).toBe(false);
  });

  it('clears condition with contains operator and non-empty value', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'condition',
          config: { predicate: { field: 'status', operator: 'contains', value: 'done' } },
        }),
      ),
    ).toBe(false);
  });

  it('flags schedule_trigger without cron', () => {
    expect(
      flowNodeNeedsAttention(node({ id: '1', blockType: 'schedule_trigger', config: {} })),
    ).toBe(true);
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'schedule_trigger',
          config: { cronExpression: '0 * * * *' },
        }),
      ),
    ).toBe(false);
  });

  it('does not flag post_task_trigger for attention', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'post_task_trigger', config: { triggerStates: ['done'] } }),
      ),
    ).toBe(false);
  });

  it('flags chat_reply without messageTemplate', () => {
    expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'chat_reply', config: {} }))).toBe(
      true,
    );
  });

  it('clears chat_reply with messageTemplate', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'chat_reply', config: { messageTemplate: 'Done!' } }),
      ),
    ).toBe(false);
  });

  it('clears chat_reply attention only when both artifact fields are present', () => {
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'chat_reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: 'Report',
            artifactBodyHtmlTemplate: '<p>Done</p>',
          },
        }),
      ),
    ).toBe(false);
    expect(
      flowNodeNeedsAttention(
        node({
          id: '1',
          blockType: 'chat_reply',
          config: { contentType: 'html_artifact', artifactTitleTemplate: 'Report' },
        }),
      ),
    ).toBe(true);
  });

  it('fan_out with no config never needs attention (arrayField defaults to items)', () => {
    expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'fan_out', config: {} }))).toBe(false);
  });

  it('fan_out with explicit arrayField never needs attention', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'fan_out', config: { arrayField: 'prs' } }),
      ),
    ).toBe(false);
  });
});

describe('flowNodeSummaryLine extras', () => {
  it('approval without message', () => {
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'approval', config: {} }))).toBe(
      'Approval required',
    );
  });

  it('webhook trigger names its event, or asks for one', () => {
    expect(
      flowNodeSummaryLine(node({ id: '1', blockType: 'webhook_trigger', label: 'Hook' })),
    ).toBe('Choose an event');
    expect(
      flowNodeSummaryLine(
        node({ id: '1', blockType: 'webhook_trigger', config: { eventType: 'issue.created' } }),
      ),
    ).toBe('On issue.created');
  });

  it('start task asks for a project until the step or the flow has one', () => {
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'start_task' }))).toBe('Set a project');
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'start_task' }), 'p1')).toBe(
      'Sets up the project, worktree and branch',
    );
  });

  it('agent: shows instructions when present (model/project from Start Task)', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'agent',
          config: { instructions: 'Review code', model: 'fast' },
        }),
      ),
    ).toBe('Review code');
  });

  it('agent: prompts for instructions only (project comes from Start Task)', () => {
    expect(
      flowNodeSummaryLine(
        node({ id: '1', blockType: 'agent', config: {} }),
        'flow-default-project-id',
      ),
    ).toBe('Add instructions');
  });

  it('agent: shows "Add instructions" when instructions missing', () => {
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'agent', config: {} }))).toBe(
      'Add instructions',
    );
  });

  it('run_command: shows "Add command" (not "and project") when flow default provides project', () => {
    expect(
      flowNodeSummaryLine(
        node({ id: '1', blockType: 'run_command', config: {} }),
        'flow-default-project-id',
      ),
    ).toBe('Add command');
  });

  it('chat_reply: shows message template when present', () => {
    expect(
      flowNodeSummaryLine(
        node({ id: '1', blockType: 'chat_reply', config: { messageTemplate: 'Done!' } }),
      ),
    ).toBe('Done!');
  });

  it('chat_reply: identifies an interactive artifact by its title', () => {
    expect(
      flowNodeSummaryLine(
        node({
          id: '1',
          blockType: 'chat_reply',
          config: {
            contentType: 'html_artifact',
            artifactTitleTemplate: 'Build report',
            artifactBodyHtmlTemplate: '<p>Done</p>',
          },
        }),
      ),
    ).toBe('Interactive: Build report');
  });

  it('chat_reply: prompts for message template when missing', () => {
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'chat_reply', config: {} }))).toBe(
      'Add message template',
    );
  });
});

describe('custom node blocks', () => {
  it('flowNodeSummaryLine uses catalog description when provided', () => {
    const line = flowNodeSummaryLine(
      node({ id: '1', blockType: 'greeting_generator', config: { projectId: 'p' } }),
      undefined,
      { customDescriptionByBlockType: new Map([['greeting_generator', 'Says hello']]) },
    );
    expect(line).toBe('Says hello');
  });

  it('flowNodeNeedsAttention when custom block missing from catalog set', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'greeting_generator', config: { projectId: 'p' } }),
        undefined,
        { customCatalogNames: new Set<string>() },
      ),
    ).toBe(true);
  });

  it('flowNodeNeedsAttention is false for a plugin step with no project', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'clickup_create_task', config: {} }),
        undefined,
      ),
    ).toBe(false);
  });

  it('flowNodeNeedsAttention stays true for a plugin step despawned from the catalog', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'clickup_create_task', config: {} }),
        undefined,
        {
          customCatalogNames: new Set<string>(),
        },
      ),
    ).toBe(true);
  });

  it('flowNodeNeedsAttention skips catalog check when customCatalogNames is null', () => {
    expect(
      flowNodeNeedsAttention(
        node({ id: '1', blockType: 'greeting_generator', config: { projectId: 'p' } }),
        undefined,
        { customCatalogNames: null },
      ),
    ).toBe(false);
  });
});

describe('end block', () => {
  it('flowNodeSummaryLine returns a fixed description', () => {
    expect(flowNodeSummaryLine(node({ id: '1', blockType: 'end' }))).toBe('Terminates this branch');
  });

  it('flowNodeNeedsAttention never flags end node', () => {
    expect(flowNodeNeedsAttention(node({ id: '1', blockType: 'end' }))).toBe(false);
  });
});

describe('flowNodeSummaryLine (fan_out)', () => {
  it('shows default field name when arrayField is not set', () => {
    const line = flowNodeSummaryLine(node({ id: '1', blockType: 'fan_out', config: {} }));
    expect(line).toContain('items');
  });

  it('shows custom arrayField in summary', () => {
    const line = flowNodeSummaryLine(
      node({ id: '1', blockType: 'fan_out', config: { arrayField: 'prs' } }),
    );
    expect(line).toContain('prs');
  });

  it('includes max iterations in summary when set', () => {
    const line = flowNodeSummaryLine(
      node({ id: '1', blockType: 'fan_out', config: { arrayField: 'items', maxIterations: 10 } }),
    );
    expect(line).toContain('max 10');
  });
});

describe('plugin step summary line', () => {
  it('uses the catalog description before the async catalog map has loaded', () => {
    expect(
      flowNodeSummaryLine(
        node({ id: '1', blockType: 'clickup_create_task', config: {} }),
        undefined,
      ),
    ).toBe('Creates a task in a List with its description, assignees and due date.');
  });

  it('never appends a set-project hint to a plugin step', () => {
    expect(
      flowNodeSummaryLine(node({ id: '1', blockType: 'clickup_get_task', config: {} }), undefined),
    ).not.toContain('set project');
  });
});

describe('flowNodeNeedsProject', () => {
  it('is false for a plugin step, so the canvas shows no set-project CTA', () => {
    expect(
      flowNodeNeedsProject(
        node({ id: '1', blockType: 'clickup_create_task', config: {} }),
        undefined,
      ),
    ).toBe(false);
  });

  it('stays true for a user-authored custom node with no project', () => {
    expect(
      flowNodeNeedsProject(node({ id: '1', blockType: 'my_node', config: {} }), undefined),
    ).toBe(true);
  });

  it('is true for project-requiring blocks with no node project and no flow default', () => {
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'start_task' }))).toBe(true);
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'run_command' }))).toBe(true);
  });

  it('node-level override resolves it', () => {
    expect(
      flowNodeNeedsProject(node({ id: '1', blockType: 'start_task', config: { projectId: 'p1' } })),
    ).toBe(false);
  });

  it('flow default resolves it', () => {
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'start_task' }), 'p1')).toBe(false);
  });

  it('is false for blocks that never need a project, even unconfigured', () => {
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'agent' }))).toBe(false);
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'http_request' }))).toBe(false);
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'manual_trigger' }))).toBe(false);
  });

  it('covers custom node blocks (project required)', () => {
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'my-org.custom-thing' }))).toBe(true);
    expect(flowNodeNeedsProject(node({ id: '1', blockType: 'my-org.custom-thing' }), 'p1')).toBe(
      false,
    );
  });
});
