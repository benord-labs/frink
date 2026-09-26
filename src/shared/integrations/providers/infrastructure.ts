import type { Provider } from '../types';

/** What runs and stores your product: Cloudflare's edge, Vercel deployments, Supabase tables. */
export const INFRASTRUCTURE_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'cloudflare',
    display_name: 'Cloudflare',
    icon: 'cloudflare',
    description: 'Workers, KV, R2 and D1 in your account',
    long_description:
      'Ask your chats about the Workers, R2 buckets and D1 databases in your Cloudflare account, and start a Flow when Cloudflare raises one of its notifications.',
    category: 'infrastructure',
    status: 'available',
    events: [
      {
        id: 'notification_received',
        label: 'Any Cloudflare notification',
        description:
          'Runs for every notification your Cloudflare webhook destination sends to Frink.',
        requirement: 'The notification policies pointed at this destination choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'health_check_changed',
        label: 'A health check changed status',
        description: 'Runs when Cloudflare reports a health check changing status.',
        filter_field_ids: [],
        vendor_events: ['health_check_status_notification'],
      },
      {
        id: 'ddos_attack_detected',
        label: 'A DDoS attack was detected',
        description: 'Runs when Cloudflare reports a layer 4 or layer 7 DDoS attack.',
        filter_field_ids: [],
        vendor_events: ['advanced_ddos_attack_l4_alert', 'advanced_ddos_attack_l7_alert'],
      },
      {
        id: 'certificate_event',
        label: 'An SSL certificate changed',
        description: 'Runs when Cloudflare sends a dedicated SSL certificate notification.',
        filter_field_ids: [],
        vendor_events: ['dedicated_ssl_certificate_event_type'],
      },
    ],
    filter_fields: [],
    subscription: 'auto',
    registrar: {
      adapter: 'cloudflare',
      credential: 'mcp',
      mcpServerId: 'notifications',
      setup: 'resources',
    },
    webhook_setup: {
      url: 'https://dash.cloudflare.com/?to=/:account/notifications',
      steps: [
        'Click the button below to open Cloudflare Notifications',
        'Open the Destinations tab and create a webhook',
        'Name it and paste the Webhook address into the URL field, then save',
        'Back on Notifications, add this webhook to each alert you want Frink to hear about',
      ],
    },
    // No per-delivery id in the body (alert_correlation_id groups related alerts rather than
    // naming one delivery), so a redelivery falls back to a body hash.
    webhook_payload: {
      event_type_path: 'alert_type',
      signature: { secret_header: 'cf-webhook-auth' },
    },
    payload_extractor: 'generic',
  },
  {
    id: 'vercel',
    display_name: 'Vercel',
    icon: 'vercel',
    description: 'Deployments, projects and logs',
    long_description:
      'Start a Flow the moment a Vercel deployment succeeds or fails, so a broken build reaches you where the work already is.',
    category: 'infrastructure',
    status: 'available',
    events: [
      {
        id: 'event_received',
        label: 'Any Vercel event',
        description: 'Runs for every event your Vercel webhook sends to Frink.',
        requirement: 'The events ticked on the webhook in Vercel choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'deployment_succeeded',
        label: 'A deployment succeeded',
        description: 'Runs when a Vercel deployment finishes successfully.',
        filter_field_ids: [],
        vendor_events: ['deployment.succeeded'],
      },
      {
        id: 'deployment_failed',
        label: 'A deployment failed',
        description: 'Runs when a Vercel deployment errors out.',
        filter_field_ids: [],
        vendor_events: ['deployment.error'],
      },
      {
        id: 'deployment_created',
        label: 'A deployment started',
        description: 'Runs when a new Vercel deployment is created.',
        filter_field_ids: [],
        vendor_events: ['deployment.created'],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    webhook_setup: {
      // Webhooks sit under the selected team's settings, so the dashboard is the stable
      // page to start from.
      url: 'https://vercel.com/dashboard',
      secret: {
        label: 'Webhook secret',
        instructions:
          'Copy the secret shown when you create the webhook in Vercel. It is shown only once. Save a replacement here if you recreate the webhook.',
      },
      steps: [
        'Click the button below to open your Vercel dashboard',
        'Pick the team you want, then open Settings → Webhooks',
        'Click "Create Webhook" and paste the Frink address below into the endpoint field',
        'Tick the deployment events you want and choose the projects, then create it',
        'Copy the secret from the confirmation screen and paste it into "Webhook secret" below',
      ],
    },
    webhook_payload: { event_type_path: 'type', event_id_path: 'id', signature: 'vercel' },
    payload_extractor: 'generic',
  },
  {
    id: 'supabase',
    display_name: 'Supabase',
    icon: 'supabase',
    description: 'Projects, tables and SQL on Supabase',
    long_description:
      'Start a Flow whenever a row is inserted, updated or deleted in a Supabase table you choose to watch.',
    category: 'infrastructure',
    status: 'coming_soon',
    events: [
      {
        id: 'row_changed',
        label: 'Any change to a watched table',
        description: 'Runs for every database webhook your Supabase project sends to Frink.',
        requirement: 'Each Supabase webhook watches one table and the operations you tick.',
        filter_field_ids: ['table'],
      },
      {
        id: 'row_inserted',
        label: 'A row was added',
        description: 'Runs when a row is inserted into a watched table.',
        filter_field_ids: ['table'],
        vendor_events: ['INSERT'],
      },
      {
        id: 'row_updated',
        label: 'A row was updated',
        description: 'Runs when a row in a watched table changes.',
        filter_field_ids: ['table'],
        vendor_events: ['UPDATE'],
      },
      {
        id: 'row_deleted',
        label: 'A row was deleted',
        description: 'Runs when a row is deleted from a watched table.',
        filter_field_ids: ['table'],
        vendor_events: ['DELETE'],
      },
    ],
    filter_fields: [{ id: 'table', label: 'Table', value_source: 'static_enum', path: 'table' }],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://supabase.com/dashboard/project/_/integrations/webhooks/overview',
      steps: [
        'Click the button below to open Database Webhooks for your project',
        'Click "Create a new hook" and pick the table to watch',
        'Tick the Insert, Update and Delete events you want',
        'Choose the HTTP Request type and paste the Webhook address as the URL, then save',
      ],
    },
    // The body carries only type/table/schema/record — no delivery id — so a redelivery
    // falls back to a body hash.
    webhook_payload: { event_type_path: 'type' },
    payload_extractor: 'generic',
  },
];
