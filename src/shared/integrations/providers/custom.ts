import type { Provider } from '../types';

/** No vendor behind it: any system that can POST. */
export const CUSTOM_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'generic_webhook',
    display_name: 'Generic Webhook',
    icon: 'webhook',
    description: 'Trigger a flow from any HTTP webhook',
    long_description:
      'Point any external system at a secret Frink URL and its HTTP POST starts a Flow. There is no account to connect, and you can mint several endpoints so different systems stay separate.',
    category: 'custom',
    status: 'available',
    events: [
      {
        id: 'received',
        label: 'Webhook received',
        description: "Runs when this webhook's URL receives an HTTP POST.",
        filter_field_ids: [],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    // No vendor to name an event, so every POST is `received`; the sender signs with Frink's
    // own HMAC because an arbitrary system carries no identity of its own.
    webhook_payload: { signature: 'frink_hmac' },
    payload_extractor: 'generic',
  },
];
