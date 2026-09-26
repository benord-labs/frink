import type { TriggerSampleCatalog } from '../types';

/** Money moving in your account. One raw vendor body per catalog event. */
export const PAYMENTS_TRIGGER_SAMPLES = {
  square: {
    // A real Square event no named intent claims, so it lands on the catch-all.
    event_received: {
      merchant_id: 'MLK9',
      type: 'refund.created',
      event_id: 'ev_refund_01',
      created_at: '2026-09-08T09:00:00Z',
      data: {
        type: 'refund',
        id: 'rf_4410',
        object: { refund: { id: 'rf_4410', amount_money: { amount: 1200, currency: 'GBP' } } },
      },
    },
    payment_created: {
      merchant_id: 'MLK9',
      type: 'payment.created',
      event_id: 'ev_payment_01',
      created_at: '2026-09-08T09:00:00Z',
      data: {
        type: 'payment',
        id: 'py_8842',
        object: {
          payment: {
            id: 'py_8842',
            status: 'COMPLETED',
            amount_money: { amount: 4500, currency: 'GBP' },
          },
        },
      },
    },
    payment_updated: {
      merchant_id: 'MLK9',
      type: 'payment.updated',
      event_id: 'ev_payment_02',
      created_at: '2026-09-08T09:05:00Z',
      data: {
        type: 'payment',
        id: 'py_8842',
        object: {
          payment: {
            id: 'py_8842',
            status: 'COMPLETED',
            amount_money: { amount: 4500, currency: 'GBP' },
          },
        },
      },
    },
    order_created: {
      merchant_id: 'MLK9',
      type: 'order.created',
      event_id: 'ev_order_01',
      created_at: '2026-09-08T09:00:00Z',
      data: {
        type: 'order',
        id: 'or_1120',
        object: { order_created: { order_id: 'or_1120', state: 'OPEN', location_id: 'L44' } },
      },
    },
  },

  paypal: {
    // A real PayPal event no named intent claims, so it lands on the catch-all.
    event_received: {
      id: 'WH-pending-01',
      event_type: 'PAYMENT.CAPTURE.PENDING',
      create_time: '2026-09-08T09:00:00Z',
      resource_type: 'capture',
      summary: 'A payment capture is pending',
      resource: {
        id: '3RM8842',
        status: 'PENDING',
        amount: { currency_code: 'GBP', value: '45.00' },
      },
    },
    capture_completed: {
      id: 'WH-completed-01',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-09-08T09:00:00Z',
      resource_type: 'capture',
      summary: 'Payment completed for £45.00 GBP',
      resource: {
        id: '3RM8842',
        status: 'COMPLETED',
        amount: { currency_code: 'GBP', value: '45.00' },
      },
    },
    capture_refused: {
      id: 'WH-declined-01',
      event_type: 'PAYMENT.CAPTURE.DECLINED',
      create_time: '2026-09-08T09:00:00Z',
      resource_type: 'capture',
      summary: 'A payment capture was declined',
      resource: {
        id: '3RM8843',
        status: 'DECLINED',
        amount: { currency_code: 'GBP', value: '45.00' },
      },
    },
    capture_refunded: {
      id: 'WH-refunded-01',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      create_time: '2026-09-08T09:10:00Z',
      resource_type: 'refund',
      summary: 'A £45.00 GBP payment was refunded',
      resource: {
        id: '4RF1120',
        status: 'COMPLETED',
        amount: { currency_code: 'GBP', value: '45.00' },
      },
    },
    order_approved: {
      id: 'WH-approved-01',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      create_time: '2026-09-08T09:00:00Z',
      resource_type: 'checkout-order',
      summary: 'A buyer approved a checkout order',
      resource: { id: '5CO7712', status: 'APPROVED', intent: 'CAPTURE' },
    },
  },
} satisfies TriggerSampleCatalog;
