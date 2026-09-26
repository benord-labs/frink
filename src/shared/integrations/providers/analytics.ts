import type { Provider } from '../types';

/** What your product is doing in the wild: PostHog events, Sentry errors. */
export const ANALYTICS_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'posthog',
    display_name: 'PostHog',
    icon: 'posthog',
    description: 'Events, flags and funnels',
    long_description:
      'Ask your chats what your product analytics say, which flags are on and where users drop off, and start a Flow the moment PostHog sees an event you care about.',
    category: 'analytics',
    status: 'available',
    // No credential: a PostHog webhook destination posts to a secret Frink address. Chat tools
    // ride the catalog MCP server instead, so the endpoint row is optional beside them.
    events: [
      {
        id: 'event_matched',
        label: 'An event matched your destination',
        description:
          'Runs for each event a PostHog webhook destination sends to Frink, other than a captured error.',
        requirement: "The destination's filters in PostHog choose which events are sent.",
        filter_field_ids: ['event', 'distinctId'],
      },
      {
        id: 'error_captured',
        label: 'An error was captured',
        description: 'Runs when PostHog sends a captured error (an $exception event) to Frink.',
        requirement: "The destination's filters in PostHog must include the $exception event.",
        filter_field_ids: ['distinctId'],
        vendor_events: ['$exception'],
      },
    ],
    // Free text, read from the default `{ event, person }` body: the event name PostHog sends
    // ($pageview, checkout_completed) and the person's distinct ID.
    filter_fields: [
      { id: 'event', label: 'Event name', value_source: 'static_enum', path: 'event.event' },
      {
        id: 'distinctId',
        label: 'Person distinct ID',
        value_source: 'static_enum',
        path: 'event.distinct_id',
      },
    ],
    subscription: 'auto',
    // The plugin's PostHog MCP consent carries `hog_function:write`, so Frink creates the webhook
    // destination itself; the steps below are the fallback when that call cannot be made.
    registrar: { adapter: 'posthog', credential: 'mcp' },
    webhook_setup: {
      url: 'https://app.posthog.com/data-management/destinations',
      steps: [
        'Click the button below to open your PostHog destinations',
        'Click "New destination", search for "Webhook" and pick "HTTP Webhook"',
        'Paste the Webhook address into "Webhook URL"',
        'Paste the Secret into "Signing secret"',
        'Keep the default JSON body ({ event, person }) and choose which events to send under Filters',
        'Click "Create & enable"',
      ],
    },
    // The default HTTP Webhook body: `event.event` names the event, `event.uuid` is stable across
    // retries, and the destination signs every delivery, so an unsigned POST starts no Flow.
    webhook_payload: {
      event_type_path: 'event.event',
      event_id_path: 'event.uuid',
      signature: 'standard_webhooks',
    },
    payload_extractor: 'generic',
  },
  {
    id: 'sentry',
    display_name: 'Sentry',
    icon: 'sentry',
    description: 'Errors, issues and traces from your projects',
    long_description:
      'Ask your chats to look up the Sentry issues, stack traces and releases behind a bug, and start a Flow when an issue is raised, resolved or handed to someone.',
    category: 'analytics',
    status: 'available',
    // Sentry's body names the action only; the resource travels in a header the receiver does not
    // read into the event type, so every label below is action-literal.
    events: [
      {
        id: 'webhook_received',
        label: 'Any Sentry webhook',
        description: 'Runs for every webhook your Sentry integration sends to Frink.',
        requirement: 'The boxes ticked on the integration in Sentry choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'created',
        label: 'Something was created',
        description:
          "Runs when Sentry reports something new — an issue, an error or a comment. Sentry's body names the action only, not which of the three.",
        filter_field_ids: [],
        vendor_events: ['created'],
      },
      {
        id: 'issue_resolved',
        label: 'An issue was resolved',
        description: 'Runs when an issue is marked resolved in Sentry.',
        filter_field_ids: [],
        vendor_events: ['resolved'],
      },
      {
        id: 'issue_assigned',
        label: 'An issue was assigned',
        description: 'Runs when an issue is assigned to someone in Sentry.',
        filter_field_ids: [],
        vendor_events: ['assigned'],
      },
      {
        id: 'issue_archived',
        label: 'An issue was archived',
        description: 'Runs when an issue is archived in Sentry.',
        filter_field_ids: [],
        vendor_events: ['archived'],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://sentry.io/settings/',
      secret: {
        label: 'Client secret',
        instructions:
          'Copy the Client Secret from this internal integration in Sentry’s Developer Settings. Save a replacement here if you regenerate it in Sentry.',
      },
      steps: [
        'Click the button below to open your Sentry settings',
        'Choose Developer Settings and create a new internal integration',
        'Paste the Frink address below into the "Webhook URL" field',
        'Tick the Issue and Comment webhooks you want, then save',
        'Copy the integration’s Client Secret and paste it into "Client secret" below',
      ],
    },
    // No per-delivery id in the body — Sentry sends it as the `Request-ID` header — so a
    // redelivery falls back to a body hash.
    webhook_payload: { event_type_path: 'action', signature: 'sentry' },
    payload_extractor: 'generic',
  },
];
