import type { TriggerSampleCatalog } from '../types';

/** What runs and stores your product. One raw vendor body per catalog event. */
export const INFRASTRUCTURE_TRIGGER_SAMPLES = {
  cloudflare: {
    // A real Cloudflare alert no named intent claims, so it lands on the catch-all.
    notification_received: {
      alert_type: 'billing_usage_alert',
      name: 'Usage alert',
      text: 'Workers requests passed 80% of your plan.',
      ts: 1757000000,
      account_id: 'acct_0091',
      data: {},
    },
    health_check_changed: {
      alert_type: 'health_check_status_notification',
      name: 'Health check status changed',
      text: 'checkout-api is now unhealthy.',
      ts: 1757000000,
      account_id: 'acct_0091',
      data: { name: 'checkout-api', status: 'Unhealthy', reason: 'TCP connection failed' },
    },
    ddos_attack_detected: {
      alert_type: 'advanced_ddos_attack_l7_alert',
      name: 'DDoS attack detected',
      text: 'A layer 7 attack on acme.com is being mitigated.',
      ts: 1757000000,
      account_id: 'acct_0091',
      data: { target_hostname: 'acme.com' },
    },
    certificate_event: {
      alert_type: 'dedicated_ssl_certificate_event_type',
      name: 'Certificate event',
      text: 'The certificate for acme.com was issued.',
      ts: 1757000000,
      account_id: 'acct_0091',
      data: { hostname: 'acme.com', status: 'active' },
    },
  },

  vercel: {
    // A real Vercel event no named intent claims, so it lands on the catch-all.
    event_received: {
      id: 'evt_canceled_01',
      type: 'deployment.canceled',
      createdAt: 1757000000000,
      payload: {
        deployment: { id: 'dpl_9931', name: 'storefront', url: 'storefront-9931.vercel.app' },
        project: { id: 'prj_0091' },
        target: 'production',
      },
    },
    deployment_succeeded: {
      id: 'evt_succeeded_01',
      type: 'deployment.succeeded',
      createdAt: 1757000000000,
      payload: {
        deployment: { id: 'dpl_9931', name: 'storefront', url: 'storefront-9931.vercel.app' },
        project: { id: 'prj_0091' },
        target: 'production',
      },
    },
    deployment_failed: {
      id: 'evt_error_01',
      type: 'deployment.error',
      createdAt: 1757000000000,
      payload: {
        deployment: { id: 'dpl_9932', name: 'storefront', url: 'storefront-9932.vercel.app' },
        project: { id: 'prj_0091' },
        target: 'production',
      },
    },
    deployment_created: {
      id: 'evt_created_01',
      type: 'deployment.created',
      createdAt: 1757000000000,
      payload: {
        deployment: { id: 'dpl_9933', name: 'storefront', url: 'storefront-9933.vercel.app' },
        project: { id: 'prj_0091' },
        target: 'production',
      },
    },
  },

  supabase: {
    // Supabase sends only INSERT/UPDATE/DELETE and each has its own intent here, so the catch-all
    // stands for a body Frink cannot name — it carries no `type` at all.
    row_changed: { table: 'orders', schema: 'public', record: { id: 8842, status: 'paid' } },
    row_inserted: {
      type: 'INSERT',
      table: 'orders',
      schema: 'public',
      record: { id: 8842, status: 'paid' },
      old_record: null,
    },
    row_updated: {
      type: 'UPDATE',
      table: 'orders',
      schema: 'public',
      record: { id: 8842, status: 'refunded' },
      old_record: { id: 8842, status: 'paid' },
    },
    row_deleted: {
      type: 'DELETE',
      table: 'orders',
      schema: 'public',
      record: null,
      old_record: { id: 8842, status: 'paid' },
    },
  },
} satisfies TriggerSampleCatalog;
