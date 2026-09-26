import type { Provider } from '../types';

/** Trackers where work is filed and moved: Shortcut, ClickUp, Linear, Jira. */
export const TICKETING_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'shortcut',
    display_name: 'Shortcut',
    icon: 'shortcut',
    description: 'Story tracking',
    long_description:
      "Frink watches your Shortcut workspace and starts a Flow when a story needs you. Agents working in that Flow can read story detail through Shortcut's own MCP server, and a Flow step can file a new story back.",
    category: 'ticketing',
    status: 'available',
    web_domain: 'https://app.shortcut.com',
    events: [
      {
        id: 'story_assigned',
        label: 'Story assigned',
        description: 'Runs when a story gains an assignee.',
        filter_field_ids: ['storyType'],
        assignee: true,
      },
      {
        id: 'story_moved',
        label: 'Story moves to state',
        description: 'Runs when a story moves into a workflow state you choose.',
        filter_field_ids: ['storyType'],
      },
      {
        id: 'story_created',
        label: 'New story created',
        description: 'Runs when a new story is created in your workspace.',
        filter_field_ids: ['storyType', 'labels', 'projectId', 'epicId'],
        assignee: true,
      },
    ],
    // A filter id IS the event-data key matchesConditions reads (buildEventData's names). Update
    // actions carry only story_type, so labels/project/epic are offered on story_created alone.
    filter_fields: [
      {
        id: 'storyType',
        label: 'Story Type',
        value_source: 'static_enum',
        static_values: ['feature', 'bug', 'chore'],
      },
      { id: 'labels', label: 'Labels', value_source: 'text' },
      { id: 'projectId', label: 'Project ID', value_source: 'text' },
      { id: 'epicId', label: 'Epic ID', value_source: 'text' },
    ],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://app.shortcut.com/settings/integrations/incoming-webhooks',
      steps: [
        'Open Shortcut webhook settings.',
        'Click "Add New Webhook".',
        'Copy the Frink address below and paste it into "Webhook URL".',
        'Copy the Frink secret below and paste it into "Secret".',
        'Click "Create".',
      ],
    },
    // Shortcut puts a bare hex HMAC-SHA256 of the raw body in `Payload-Signature`, and the body's
    // top-level `id` is the delivery id. It names no event string, so `payload_extractor` reads it.
    webhook_payload: {
      event_id_path: 'id',
      owner_path: 'member_id',
      signature: { hex_hmac_header: 'payload-signature' },
    },
    payload_extractor: 'shortcut',
  },
  {
    id: 'clickup',
    display_name: 'ClickUp',
    icon: 'clickup',
    description: 'Task management',
    long_description:
      'The official ClickUp plugin brings workspace tools and guided workflows for standups, task breakdowns and repeat projects. Task events can start your Flows after webhook setup.',
    category: 'ticketing',
    status: 'available',
    events: [
      {
        id: 'event_received',
        label: 'Any ClickUp event',
        description: 'Runs for every event your ClickUp webhook sends to Frink.',
        filter_field_ids: [],
      },
      {
        id: 'task_created',
        label: 'New task created',
        description: 'Runs when a task is created in the selected workspace.',
        filter_field_ids: [],
        vendor_events: ['taskCreated'],
      },
      {
        id: 'task_status_changed',
        label: 'Task status changed',
        description: 'Runs when a task status changes, including its initial status on creation.',
        filter_field_ids: [],
        vendor_events: ['taskStatusUpdated'],
      },
      {
        id: 'task_assignee_changed',
        label: 'Task assignees changed',
        description: 'Runs when an assignee is added to or removed from a task.',
        filter_field_ids: [],
        vendor_events: ['taskAssigneeUpdated'],
      },
      {
        id: 'task_commented',
        label: 'Comment added',
        description: 'Runs when someone adds a comment to a task.',
        filter_field_ids: [],
        vendor_events: ['taskCommentPosted'],
      },
    ],
    filter_fields: [],
    subscription: 'auto',
    registrar: {
      adapter: 'clickup',
      credential: 'api_token',
      setup: 'api_token',
      tokenSetup: {
        label: 'API key',
        url: 'https://developer.clickup.com/docs/authentication#personal-token',
        resourceLabel: 'workspace',
      },
    },
    webhook_setup: {
      url: 'https://developer.clickup.com/reference/createwebhook',
      steps: [
        'Create a webhook with the ClickUp API for the workspace you want to watch',
        'Use the Webhook address as the endpoint and choose the events to send',
        'Copy the secret returned by ClickUp into Frink’s signing secret field',
      ],
    },
    webhook_payload: { event_type_path: 'event', signature: { hex_hmac_header: 'x-signature' } },
    payload_extractor: 'generic',
  },
  {
    id: 'linear',
    display_name: 'Linear',
    icon: 'linear',
    description: 'Issue tracking',
    long_description:
      'Frink watches your Linear workspace and starts a Flow when an issue needs you, so work filed in Linear can begin without you restating it.',
    category: 'ticketing',
    status: 'available',
    web_domain: 'https://linear.app',
    events: [
      {
        id: 'issue_status_changed',
        label: 'Issue status changed',
        description: "Runs when an issue's workflow state changes.",
        filter_field_ids: ['priorityLabel'],
      },
      {
        id: 'issue_created',
        label: 'New issue created',
        description: 'Runs when a new issue is created in your workspace.',
        filter_field_ids: ['priorityLabel'],
      },
      {
        id: 'issue_commented',
        label: 'Comment added',
        description: 'Runs when someone comments on an issue.',
        // No priority filter: a Comment delivery carries no priorityLabel, so any
        // configured value would drop every comment.
        filter_field_ids: [],
      },
    ],
    // A filter id IS the event-data key matchesConditions reads, so it must be what buildEventData
    // writes. Team and label filters are absent: both would need a raw Linear UUID typed by hand.
    filter_fields: [
      {
        id: 'priorityLabel',
        label: 'Priority',
        value_source: 'static_enum',
        // Linear's own priorityLabel values, which the extractor forwards verbatim.
        static_values: ['Urgent', 'High', 'Medium', 'Low', 'No priority'],
      },
    ],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://linear.app/settings/api',
      secret: {
        label: 'Signing secret',
        instructions:
          'Copy the signing secret Linear shows for this webhook. If you create the webhook again in Linear, save its new secret here.',
      },
      steps: [
        'Open Linear’s API settings.',
        'Under Webhooks, click "New webhook".',
        'Copy the Frink address below and paste it into "URL".',
        'Choose Issues and Comments, then click "Create webhook".',
        'Copy Linear’s signing secret and paste it into "Signing secret" below.',
      ],
    },
    // Linear signs the raw body with a bare hex HMAC-SHA256 and its ids inside the body name the
    // issue, not the delivery, so a redelivery replays on the body's own hash.
    webhook_payload: {
      signature: { hex_hmac_header: 'linear-signature' },
    },
    payload_extractor: 'linear',
  },
  {
    id: 'atlassian',
    display_name: 'Atlassian',
    icon: 'atlassian',
    description: 'Jira issues and Confluence pages',
    long_description:
      'Ask your chats about your Jira queue and the Confluence pages behind it, and start a Flow when a Jira issue is filed, changed or commented on.',
    category: 'ticketing',
    status: 'coming_soon',
    events: [
      {
        id: 'event_received',
        label: 'Any Jira event',
        description: 'Runs for every event your Jira webhook sends to Frink.',
        requirement: 'The events ticked on the webhook in Jira choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'issue_created',
        label: 'An issue was created',
        description: 'Runs when someone files a new Jira issue.',
        filter_field_ids: [],
        vendor_events: ['jira:issue_created'],
      },
      {
        id: 'issue_updated',
        label: 'An issue was updated',
        description: 'Runs when a Jira issue changes — a field edit, a status move, an assignment.',
        filter_field_ids: [],
        vendor_events: ['jira:issue_updated'],
      },
      {
        id: 'comment_created',
        label: 'A comment was added',
        description: 'Runs when someone comments on a Jira issue.',
        filter_field_ids: [],
        vendor_events: ['comment_created'],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    webhook_setup: {
      // Jira's webhook page lives on your own site (…atlassian.net/plugins/servlet/webhooks);
      // start.atlassian.com is the stable page that lists the sites you can open.
      url: 'https://start.atlassian.com',
      steps: [
        'Click the button below and open your Jira site',
        'Choose Settings (the gear) → System → WebHooks',
        'Click "Create a WebHook" and paste the Webhook address into the URL field',
        'Tick the issue and comment events you want, then click Create',
      ],
    },
    // Jira names the event in the body; its per-delivery id is header-only
    // (X-Atlassian-Webhook-Identifier), so redelivery falls back to a body hash.
    webhook_payload: { event_type_path: 'webhookEvent' },
    payload_extractor: 'generic',
  },
];
