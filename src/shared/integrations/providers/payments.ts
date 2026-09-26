import type { Provider } from '../types';

/** Money moving in your account: Square and PayPal. */
export const PAYMENT_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: 'square',
    display_name: 'Square',
    icon: 'square',
    description: 'Catalog, orders and payments',
    long_description:
      'Ask your chats about the orders, catalog items and payments in your Square account, and start a Flow the moment a payment or an order lands.',
    category: 'payments',
    status: 'available',
    events: [
      {
        id: 'event_received',
        label: 'Any Square event',
        description: 'Runs for every event your Square webhook subscription sends to Frink.',
        requirement: 'The events ticked on the subscription in Square choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'payment_created',
        label: 'A payment was taken',
        description: 'Runs when Square records a new payment.',
        filter_field_ids: [],
        vendor_events: ['payment.created'],
      },
      {
        id: 'payment_updated',
        label: 'A payment changed',
        description: 'Runs when an existing Square payment is updated.',
        filter_field_ids: [],
        vendor_events: ['payment.updated'],
      },
      {
        id: 'order_created',
        label: 'An order was created',
        description: 'Runs when a new order is created in Square.',
        filter_field_ids: [],
        vendor_events: ['order.created'],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://developer.squareup.com/apps',
      secret: {
        label: 'Signature key',
        instructions:
          'Copy the Signature Key from this subscription in Square’s Developer Console. If you rotate it in Square, save the replacement here.',
      },
      steps: [
        'Click the button below to open your Square applications',
        'Open your application and choose Webhooks → Subscriptions',
        'Click "Add subscription" and paste the Frink address below into the notification URL',
        'Tick the payment and order events you want, then save',
        'Copy the subscription’s Signature Key and paste it into "Signature key" below',
      ],
    },
    webhook_payload: {
      event_type_path: 'type',
      event_id_path: 'event_id',
      signature: 'square',
    },
    payload_extractor: 'generic',
  },
  {
    id: 'paypal',
    display_name: 'PayPal',
    icon: 'paypal',
    description: 'Invoices, orders and payments',
    long_description:
      'Ask your chats to create an invoice, check an order or look up a payment in your PayPal account, and start a Flow when money arrives or a capture is refused.',
    category: 'payments',
    status: 'coming_soon',
    events: [
      {
        id: 'event_received',
        label: 'Any PayPal event',
        description: 'Runs for every event your PayPal webhook sends to Frink.',
        requirement: 'The event types subscribed on the webhook in PayPal choose what is sent.',
        filter_field_ids: [],
      },
      {
        id: 'capture_completed',
        label: 'A payment was captured',
        description: 'Runs when a PayPal payment capture completes.',
        filter_field_ids: [],
        vendor_events: ['PAYMENT.CAPTURE.COMPLETED'],
      },
      {
        id: 'capture_refused',
        label: 'A payment was declined or denied',
        description: 'Runs when PayPal declines or denies a payment capture.',
        filter_field_ids: [],
        vendor_events: ['PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED'],
      },
      {
        id: 'capture_refunded',
        label: 'A payment was refunded',
        description: 'Runs when a captured PayPal payment is refunded.',
        filter_field_ids: [],
        vendor_events: ['PAYMENT.CAPTURE.REFUNDED'],
      },
      {
        id: 'order_approved',
        label: 'A buyer approved an order',
        description: 'Runs when a buyer approves a PayPal checkout order.',
        filter_field_ids: [],
        vendor_events: ['CHECKOUT.ORDER.APPROVED'],
      },
    ],
    filter_fields: [],
    subscription: 'paste_url',
    webhook_setup: {
      url: 'https://developer.paypal.com/dashboard/',
      steps: [
        'Click the button below to open your PayPal developer dashboard',
        'Open Apps & Credentials and pick the app you use',
        'Under Webhooks click "Add webhook" and paste the Webhook address as the URL',
        'Tick the payment and order events you want, then save',
      ],
    },
    webhook_payload: { event_type_path: 'event_type', event_id_path: 'id' },
    payload_extractor: 'generic',
  },
];
