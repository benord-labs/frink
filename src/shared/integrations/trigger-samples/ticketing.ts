import type { TriggerSampleCatalog } from '../types';

/** Trackers where work is filed and moved. One raw vendor body per catalog event. */
export const TICKETING_TRIGGER_SAMPLES = {
  clickup: {
    event_received: { event: 'taskUpdated', task_id: '86a123', webhook_id: 'hook-clickup' },
    task_created: {
      event: 'taskCreated',
      task_id: '86a123',
      webhook_id: 'hook-clickup',
      history_items: [{ id: 'history-created', field: 'task_creation', before: null, after: null }],
    },
    task_status_changed: {
      event: 'taskStatusUpdated',
      task_id: '86a123',
      webhook_id: 'hook-clickup',
      history_items: [
        {
          id: 'history-status',
          field: 'status',
          before: { status: 'to do' },
          after: { status: 'in progress' },
        },
      ],
    },
    task_assignee_changed: {
      event: 'taskAssigneeUpdated',
      task_id: '86a123',
      webhook_id: 'hook-clickup',
      history_items: [
        {
          id: 'history-assignee',
          field: 'assignee',
          before: null,
          after: { id: 183, username: 'Alex' },
        },
      ],
    },
    task_commented: {
      event: 'taskCommentPosted',
      task_id: '86a123',
      webhook_id: 'hook-clickup',
      history_items: [
        {
          id: 'history-comment',
          field: 'comment',
          comment: { id: 'comment-1', text_content: 'Picking this up now.' },
        },
      ],
    },
  },
  shortcut: {
    story_created: {
      member_id: '5f7a1b2c-0000-4000-8000-000000000001',
      primary_id: 4821,
      references: [
        {
          id: 4821,
          entity_type: 'story',
          name: 'Checkout retries the failed card',
          app_url: 'https://app.shortcut.com/frink/story/4821',
        },
      ],
      actions: [
        {
          id: 4821,
          entity_type: 'story',
          action: 'create',
          name: 'Checkout retries the failed card',
          story_type: 'feature',
        },
      ],
    },
    story_assigned: {
      member_id: '5f7a1b2c-0000-4000-8000-000000000001',
      primary_id: 4821,
      references: [
        {
          id: 4821,
          entity_type: 'story',
          name: 'Checkout retries the failed card',
          app_url: 'https://app.shortcut.com/frink/story/4821',
        },
      ],
      actions: [
        {
          id: 4821,
          entity_type: 'story',
          action: 'update',
          story_type: 'feature',
          changes: {
            owner_ids: {
              adds: ['5f7a1b2c-0000-4000-8000-000000000001'],
              old: [],
              new: ['5f7a1b2c-0000-4000-8000-000000000001'],
            },
          },
        },
      ],
    },
    story_moved: {
      member_id: '5f7a1b2c-0000-4000-8000-000000000001',
      primary_id: 4821,
      references: [
        {
          id: 4821,
          entity_type: 'story',
          name: 'Checkout retries the failed card',
          app_url: 'https://app.shortcut.com/frink/story/4821',
        },
        // Only a story reference carries a URL; a workflow state has none.
        { id: 500000011, entity_type: 'workflow-state', name: 'In Progress', app_url: null },
        { id: 500000010, entity_type: 'workflow-state', name: 'Ready for Dev', app_url: null },
      ],
      actions: [
        {
          id: 4821,
          entity_type: 'story',
          action: 'update',
          story_type: 'feature',
          changes: { workflow_state_id: { old: 500000010, new: 500000011 } },
        },
      ],
    },
  },

  linear: {
    issue_created: {
      action: 'create',
      type: 'Issue',
      url: 'https://linear.app/frink/issue/ENG-412',
      organizationId: '3f0c6d8a-0000-4000-8000-00000000000a',
      actor: { id: 'b21c4e90-0000-4000-8000-00000000000b', name: 'You' },
      data: {
        id: 'a10b2c30-0000-4000-8000-00000000000c',
        identifier: 'ENG-412',
        title: 'Retry the failed card at checkout',
        teamId: 'team-eng',
        priorityLabel: 'High',
        labelIds: [],
      },
      webhookId: 'webhook-frink',
      webhookTimestamp: 1757000000000,
    },
    issue_status_changed: {
      action: 'update',
      type: 'Issue',
      url: 'https://linear.app/frink/issue/ENG-412',
      organizationId: '3f0c6d8a-0000-4000-8000-00000000000a',
      actor: { id: 'b21c4e90-0000-4000-8000-00000000000b', name: 'You' },
      updatedFrom: { stateId: 'state-todo' },
      data: {
        id: 'a10b2c30-0000-4000-8000-00000000000c',
        identifier: 'ENG-412',
        title: 'Retry the failed card at checkout',
        teamId: 'team-eng',
        stateId: 'state-in-progress',
        priorityLabel: 'High',
        labelIds: [],
      },
      webhookId: 'webhook-frink',
      webhookTimestamp: 1757000000000,
    },
    issue_commented: {
      action: 'create',
      type: 'Comment',
      url: 'https://linear.app/frink/issue/ENG-412#comment-1',
      organizationId: '3f0c6d8a-0000-4000-8000-00000000000a',
      actor: { id: 'b21c4e90-0000-4000-8000-00000000000b', name: 'You' },
      data: {
        id: 'c30d4e50-0000-4000-8000-00000000000d',
        body: 'Picking this up now.',
        issueId: 'a10b2c30-0000-4000-8000-00000000000c',
        userId: 'b21c4e90-0000-4000-8000-00000000000b',
      },
      webhookId: 'webhook-frink',
      webhookTimestamp: 1757000000000,
    },
  },

  atlassian: {
    // A real Jira event no named intent claims, so it lands on the catch-all.
    event_received: {
      webhookEvent: 'jira:issue_deleted',
      timestamp: 1757000000000,
      issue: {
        id: '10412',
        key: 'ENG-412',
        fields: { summary: 'Retry the failed card at checkout' },
      },
    },
    issue_created: {
      webhookEvent: 'jira:issue_created',
      timestamp: 1757000000000,
      user: { accountId: '5b10a2', displayName: 'You' },
      issue: {
        id: '10412',
        key: 'ENG-412',
        self: 'https://acme.atlassian.net/rest/api/2/issue/10412',
        fields: { summary: 'Retry the failed card at checkout', status: { name: 'To Do' } },
      },
    },
    issue_updated: {
      webhookEvent: 'jira:issue_updated',
      timestamp: 1757000000000,
      user: { accountId: '5b10a2', displayName: 'You' },
      issue: {
        id: '10412',
        key: 'ENG-412',
        fields: { summary: 'Retry the failed card at checkout', status: { name: 'In Progress' } },
      },
      changelog: { items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] },
    },
    comment_created: {
      webhookEvent: 'comment_created',
      timestamp: 1757000000000,
      issue: {
        id: '10412',
        key: 'ENG-412',
        fields: { summary: 'Retry the failed card at checkout' },
      },
      comment: {
        id: '9001',
        body: 'Picking this up now.',
        author: { accountId: '5b10a2', displayName: 'You' },
      },
    },
  },
} satisfies TriggerSampleCatalog;
