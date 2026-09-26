import type { Provider } from '../types';

/** Shared workspaces Frink watches for work: Notion. */
export const MESSAGING_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'notion',
    display_name: 'Notion',
    icon: 'notion',
    description: 'Pages, databases and comments',
    long_description:
      'Work with Notion pages and databases, and start a Flow when shared content changes.',
    category: 'messaging',
    status: 'available',
    subscription: 'paste_url',
    webhook_verification: 'notion',
    events: [
      {
        id: 'event_received',
        label: 'Any Notion event',
        description: 'Runs for events from your verified Notion subscription.',
        filter_field_ids: [],
      },
      {
        id: 'page_created',
        label: 'Page created',
        description: 'Runs when a page is created.',
        filter_field_ids: ['pageId'],
        vendor_events: ['page.created'],
      },
      {
        id: 'page_updated',
        label: 'Page updated',
        description: 'Runs when page content or properties change.',
        filter_field_ids: ['pageId'],
        vendor_events: ['page.content_updated', 'page.properties_updated'],
      },
      {
        id: 'comment_added',
        label: 'Comment added',
        description: 'Runs when a comment is added.',
        filter_field_ids: [],
        vendor_events: ['comment.created'],
      },
      {
        id: 'database_updated',
        label: 'Database updated',
        description: 'Runs when a database or data source changes.',
        filter_field_ids: [],
        vendor_events: ['database.schema_updated', 'data_source.schema_updated'],
      },
    ],
    filter_fields: [
      {
        id: 'pageId',
        label: 'Page ID',
        value_source: 'static_enum',
        path: 'entity.id',
      },
    ],
    webhook_setup: {
      url: 'https://www.notion.so/profile/integrations',
      steps: [
        'Open a Notion connection you own. The hosted Notion MCP connection cannot be configured here.',
        'Under Webhooks, create a subscription with this address and choose events.',
        'Copy the verification code Frink receives into Notion, then confirm below.',
        'Add that connection to the pages you want to follow.',
      ],
    },
    webhook_payload: {
      signature: 'notion',
      event_type_path: 'type',
      event_id_path: 'id',
    },
    payload_extractor: 'generic',
  },
];
