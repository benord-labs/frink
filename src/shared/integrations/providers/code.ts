import type { Provider } from '../types';

/** Where models and sites are authored and shipped: Hugging Face, Webflow. */
export const CODE_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'huggingface',
    display_name: 'Hugging Face',
    icon: 'huggingface',
    description: 'Models, datasets and Spaces',
    long_description:
      'Start a Flow when a repository you follow on the Hugging Face Hub changes, or when someone opens or answers a discussion on it.',
    category: 'code',
    status: 'available',
    events: [
      {
        id: 'webhook_received',
        label: 'Any Hugging Face event',
        description: 'Runs for every event your Hugging Face webhook sends to Frink.',
        requirement: 'The repositories, users and orgs the webhook watches choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'repo_content_changed',
        label: 'Files changed in a repository',
        description: 'Runs when a commit changes the files of a watched repository.',
        filter_field_ids: [],
        vendor_events: ['repo.content'],
      },
      {
        id: 'discussion_changed',
        label: 'A discussion or pull request changed',
        description: 'Runs when a discussion or pull request is opened, edited or deleted.',
        filter_field_ids: [],
        vendor_events: ['discussion'],
      },
      {
        id: 'discussion_comment',
        label: 'Someone commented on a discussion',
        description: 'Runs when a comment is posted or edited on a discussion or pull request.',
        filter_field_ids: [],
        vendor_events: ['discussion.comment'],
      },
    ],
    filter_fields: [],
    subscription: 'auto',
    registrar: {
      adapter: 'huggingface',
      credential: 'mcp',
      mcpServerId: 'huggingface-skills',
      setup: 'resources',
      resourceTypes: [
        { id: 'user', label: 'User' },
        { id: 'org', label: 'Organization' },
        { id: 'model', label: 'Model' },
        { id: 'dataset', label: 'Dataset' },
        { id: 'space', label: 'Space' },
      ],
    },
    webhook_setup: {
      url: 'https://huggingface.co/settings/webhooks',
      steps: [
        'Click the button below to open your Hugging Face webhooks',
        'Click "Add a new webhook"',
        'List the repositories, users or orgs you want to watch',
        'Paste the Webhook address into the "Target URL" field and the secret into "Secret", then save',
      ],
    },
    // `event.scope` says WHAT the event is about (repo, discussion); `event.action` says
    // create/update/delete. Scope is the discriminator a trigger is picked by.
    webhook_payload: {
      event_type_path: 'event.scope',
      signature: { secret_header: 'x-webhook-secret' },
    },
    payload_extractor: 'generic',
  },
  {
    id: 'webflow',
    display_name: 'Webflow',
    icon: 'webflow',
    description: 'Sites, pages and CMS collections',
    long_description:
      'Ask your chats to read and update the pages and CMS items of the Webflow sites you sign in to, and start a Flow when a form comes in or a site is published.',
    category: 'code',
    // Webflow signs nothing, and the receiver forwards no unsigned delivery.
    status: 'coming_soon',
    events: [
      {
        id: 'event_received',
        label: 'Any Webflow event',
        description: 'Runs for every event your Webflow webhook sends to Frink.',
        requirement: 'The trigger chosen on the webhook in Webflow decides what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'form_submitted',
        label: 'A form was submitted',
        description: 'Runs when a visitor submits a form on the site.',
        filter_field_ids: [],
        vendor_events: ['form_submission'],
      },
      {
        id: 'site_published',
        label: 'The site was published',
        description: 'Runs when the site is published from Webflow.',
        filter_field_ids: [],
        vendor_events: ['site_publish'],
      },
      {
        id: 'collection_item_changed',
        label: 'A CMS item was created or edited',
        description: 'Runs when an item in a CMS collection is created or changed.',
        filter_field_ids: [],
        vendor_events: ['collection_item_created', 'collection_item_changed'],
      },
    ],
    filter_fields: [],
    subscription: 'auto',
    registrar: { adapter: 'webflow', credential: 'mcp' },
    webhook_setup: {
      // Webflow's webhook list lives inside each site's settings, so the dashboard is
      // the stable page to start from.
      url: 'https://webflow.com/dashboard',
      steps: [
        'Click the button below to open your Webflow dashboard',
        'Open the site you want and go to its site settings',
        'Find the Webhooks section and click to add one',
        'Choose a trigger and paste the Webhook address as the destination URL',
      ],
    },
    // payload.id identifies the changed item, not the delivery. The receiver hashes the body
    // so distinct edits to the same item remain distinct and identical redeliveries deduplicate.
    webhook_payload: { event_type_path: 'triggerType' },
    payload_extractor: 'generic',
  },
];
