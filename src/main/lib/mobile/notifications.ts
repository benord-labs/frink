import log from 'electron-log';
import { z } from 'zod';
import {
  subscribeSessionCompletions,
  type SessionCompletion,
} from '../socket/streaming/live-stream/completion-events';
import type { MobilePairingStore } from './pairing-store';

const receiptSchema = z.object({
  status: z.enum(['ok', 'error']),
  details: z.object({ error: z.string().optional() }).optional(),
});
const ticketSchema = z.discriminatedUnion('status', [
  receiptSchema.extend({ status: z.literal('ok'), id: z.string().trim().min(1) }),
  receiptSchema.extend({ status: z.literal('error') }),
]);
const RECEIPT_DELAY_MS = 15 * 60_000;

async function expoRequest(operation: 'send' | 'getReceipts', body: unknown, signal: AbortSignal) {
  const response = await fetch(`https://exp.host/--/api/v2/push/${operation}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error(`Push service returned ${response.status}`);
  return response.json();
}

/** Delivery is independent of execution; stopping mobile access cancels outstanding requests. */
export function startMobileNotifications(store: MobilePairingStore) {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Map<
    string,
    { id: string; token: string; readyAt: number; attempts: number }
  >();
  const recordFailure = async (recipient: { id: string; token: string }, unregistered = false) => {
    if (!controller.signal.aborted)
      await store.notificationFailed(recipient.id, recipient.token, unregistered);
  };
  async function receipts() {
    const batch = [...pending]
      .filter(([, recipient]) => recipient.readyAt <= Date.now())
      .slice(0, 1000);
    if (!batch.length || controller.signal.aborted) return;
    try {
      const result = z
        .object({ data: z.record(z.string(), receiptSchema) })
        .parse(
          await expoRequest('getReceipts', { ids: batch.map(([id]) => id) }, controller.signal),
        );
      for (const [id, recipient] of batch) {
        const receipt = result.data[id];
        if (!receipt) continue;
        pending.delete(id);
        if (receipt.status === 'error')
          await recordFailure(recipient, receipt.details?.error === 'DeviceNotRegistered');
      }
    } catch {
      if (!controller.signal.aborted) log.warn('[Mobile] Notification receipt check failed.');
    } finally {
      for (const [id, recipient] of batch) {
        if (pending.has(id) && ++recipient.attempts >= 3) {
          pending.delete(id);
          await recordFailure(recipient);
        }
      }
      scheduleReceipts();
    }
  }
  function scheduleReceipts() {
    if (!pending.size || timers.size || controller.signal.aborted) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void receipts().catch(() => log.warn('[Mobile] Could not save notification receipt status.'));
    }, RECEIPT_DELAY_MS);
    timer.unref();
    timers.add(timer);
  }
  async function send(event: SessionCompletion) {
    const recipients = store.notificationRecipients();
    if (!recipients.length || controller.signal.aborted) return;
    try {
      const { data } = z.object({ data: z.array(ticketSchema) }).parse(
        await expoRequest(
          'send',
          recipients.map((recipient) => ({
            to: recipient.token,
            title: 'Frink',
            body: 'A chat on your Mac has finished.',
            sound: 'default',
            ttl: 3600,
            data: { type: 'session-completed', deviceId: recipient.id, ...event },
          })),
          controller.signal,
        ),
      );
      for (const [index, recipient] of recipients.entries()) {
        const ticket = data[index];
        if (!ticket || ticket.status === 'error')
          await recordFailure(recipient, ticket?.details?.error === 'DeviceNotRegistered');
        else
          pending.set(ticket.id, {
            ...recipient,
            readyAt: Date.now() + RECEIPT_DELAY_MS,
            attempts: 0,
          });
      }
      scheduleReceipts();
    } catch {
      for (const recipient of recipients) await recordFailure(recipient);
    }
  }
  const unsubscribe = subscribeSessionCompletions((event) => {
    void send(event).catch(() => log.warn('[Mobile] Could not save notification delivery status.'));
  });
  return () => {
    unsubscribe();
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    pending.clear();
  };
}
