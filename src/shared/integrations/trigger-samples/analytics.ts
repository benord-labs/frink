import type { TriggerSampleCatalog } from '../types';

/** What your product is doing in the wild. One raw vendor body per catalog event. */
export const ANALYTICS_TRIGGER_SAMPLES = {
  posthog: {
    event_matched: {
      event: {
        uuid: '0191e7c0-0000-7000-8000-000000000001',
        event: 'checkout_completed',
        distinct_id: 'user_8842',
        timestamp: '2026-09-08T09:00:00Z',
        properties: { $current_url: 'https://acme.com/checkout' },
      },
      person: { id: 'user_8842', properties: { email: 'sam@example.com' } },
    },
    error_captured: {
      event: {
        uuid: '0191e7c0-0000-7000-8000-000000000002',
        event: '$exception',
        distinct_id: 'user_8842',
        timestamp: '2026-09-08T09:01:00Z',
        properties: { $exception_message: 'Card declined', $exception_type: 'PaymentError' },
      },
      person: { id: 'user_8842', properties: { email: 'sam@example.com' } },
    },
  },

  sentry: {
    // `ignored` is a real Sentry action no named intent claims, so it lands on the catch-all.
    webhook_received: {
      action: 'ignored',
      installation: { uuid: '0f1e2d3c-0000-4000-8000-000000000001' },
      actor: { type: 'user', id: '77', name: 'You' },
      data: {
        issue: {
          id: '5512',
          title: 'PaymentError: Card declined',
          web_url: 'https://sentry.io/organizations/acme/issues/5512/',
        },
      },
    },
    created: {
      action: 'created',
      installation: { uuid: '0f1e2d3c-0000-4000-8000-000000000001' },
      actor: { type: 'user', id: '77', name: 'You' },
      data: {
        issue: {
          id: '5512',
          title: 'PaymentError: Card declined',
          web_url: 'https://sentry.io/organizations/acme/issues/5512/',
        },
      },
    },
    issue_resolved: {
      action: 'resolved',
      installation: { uuid: '0f1e2d3c-0000-4000-8000-000000000001' },
      actor: { type: 'user', id: '77', name: 'You' },
      data: {
        issue: {
          id: '5512',
          title: 'PaymentError: Card declined',
          web_url: 'https://sentry.io/organizations/acme/issues/5512/',
        },
      },
    },
    issue_assigned: {
      action: 'assigned',
      installation: { uuid: '0f1e2d3c-0000-4000-8000-000000000001' },
      actor: { type: 'user', id: '77', name: 'You' },
      data: {
        issue: {
          id: '5512',
          title: 'PaymentError: Card declined',
          web_url: 'https://sentry.io/organizations/acme/issues/5512/',
        },
      },
    },
    issue_archived: {
      action: 'archived',
      installation: { uuid: '0f1e2d3c-0000-4000-8000-000000000001' },
      actor: { type: 'user', id: '77', name: 'You' },
      data: {
        issue: {
          id: '5512',
          title: 'PaymentError: Card declined',
          web_url: 'https://sentry.io/organizations/acme/issues/5512/',
        },
      },
    },
  },
} satisfies TriggerSampleCatalog;
