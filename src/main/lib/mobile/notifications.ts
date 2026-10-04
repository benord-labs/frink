import log from 'electron-log';
import { z } from 'zod';
import {
  subscribeSessionCompletions,
  type SessionCompletion,
} from '../socket/streaming/live-stream/completion-events';
import { readWaitingChats, type WaitingChat, type WaitingKind } from './live-activity/counts';
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
const LOOK_MS = 5_000;
/** No input for this long, or Frink out of view, means the user is not watching it at the Mac. */
const AWAY_AFTER_S = 120;

export type DesktopReads = {
  /** Whether Frink is in view, and whole seconds since the last input anywhere on the Mac. */
  desktop: () => { inView: boolean; idle: number };
  /** The sub-chat is still working: responding, or waiting on background work. */
  isBusy: (subChatId: string) => boolean;
};

/** Generic by design: the kind of wait, never the chat's title or content. */
const NEEDS_YOU: Record<WaitingKind, { title: string; body: string }> = {
  question: { title: 'A chat has a question', body: 'Answer it to let the chat carry on.' },
  permission: {
    title: 'A chat needs your permission',
    body: 'Allow or deny it to let the chat carry on.',
  },
  plan: { title: 'A plan is ready', body: 'Review it, then approve or change it.' },
  attention: { title: 'A task needs you', body: 'Open it to see what it’s waiting for.' },
};

type Alert = {
  title: string;
  body: string;
  urgent: boolean;
  /** One alert per chat in Notification Center: a newer one replaces the older. */
  collapseId: string;
  data: Record<string, string>;
};

const finishedAlert = (event: SessionCompletion): Alert => ({
  title: 'A chat finished',
  body: 'Open it to see the result.',
  urgent: false,
  collapseId: event.chatId,
  data: { type: 'session-completed', ...event },
});

function needsYouAlert(chatId: string, { kind, subChatId }: WaitingChat): Alert {
  // A chat-less task is keyed `task:<id>`; its alert opens the Queue instead of a chat.
  const chat = chatId.startsWith('task:') ? {} : { chatId, ...(subChatId && { subChatId }) };
  return {
    ...NEEDS_YOU[kind],
    urgent: true,
    collapseId: chatId,
    data: { type: 'needs-you', ...chat },
  };
}

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

const elapsed = (since: number, now: number) => Math.floor((now - since) / 1000);

/** Delivery is independent of execution; stopping mobile access cancels outstanding requests. */
export function startMobileNotifications(
  store: MobilePairingStore,
  { desktop, isBusy }: DesktopReads,
) {
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
  async function send({ title, body, urgent, collapseId, data: ids }: Alert) {
    const recipients = store.notificationRecipients();
    if (!recipients.length || controller.signal.aborted) return;
    try {
      const { data } = z.object({ data: z.array(ticketSchema) }).parse(
        await expoRequest(
          'send',
          recipients.map((recipient) => ({
            to: recipient.token,
            title,
            body,
            sound: 'default',
            ttl: 3600,
            // Time-sensitive alerts reach the Lock Screen through a Focus the user lets them past.
            interruptionLevel: urgent ? 'time-sensitive' : 'active',
            collapseId,
            data: { ...ids, deviceId: recipient.id },
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
  const deliver = (alert: Alert) => {
    log.info(`[Mobile] Sending ${alert.data.type} alert for ${alert.collapseId}.`);
    void send(alert).catch(() => log.warn('[Mobile] Could not save notification delivery status.'));
  };

  // Chats waiting on the user at the last look (null until the first), and those already alerted.
  let seen: Map<string, WaitingChat> | null = null;
  const alerted = new Set<string>();
  // A finished run is held until its chat is quiet for two looks and the user is away from the Mac.
  type Finished = { event: SessionCompletion; quietAt: number; quietIdle: number; looks: number };
  const finished = new Map<string, Finished>();
  // The last look that found Frink in view: focus may move on before the next one.
  let lastInView = 0;
  function releaseFinished(
    waiting: Map<string, WaitingChat>,
    now: number,
    idle: number,
    away: boolean,
  ) {
    for (const [chatId, entry] of finished) {
      // Parked on the user: that wait alerts by itself.
      if (waiting.has(chatId)) finished.delete(chatId);
      // Every completion published before the chat is really done collapses into one alert.
      else if (isBusy(entry.event.subChatId)) entry.looks = 0;
      else if (entry.looks++ === 0) Object.assign(entry, { quietAt: now, quietIdle: idle });
      // Seen: Frink was in view once the chat was quiet, and there has been input since. Idle is
      // whole seconds, so it is measured against its own reading then: never early, at most late.
      else if (lastInView >= entry.quietAt && idle < entry.quietIdle + elapsed(entry.quietAt, now))
        finished.delete(chatId);
      else if (away) {
        finished.delete(chatId);
        deliver(finishedAlert(entry.event));
      }
    }
  }
  // What already waited when alerts came on is not news; a new wait must hold for two looks,
  // so one answered at the Mac within seconds never reaches the phone.
  function alertNewWaits(waiting: Map<string, WaitingChat>, previous: typeof seen, away: boolean) {
    for (const chatId of alerted) if (!waiting.has(chatId)) alerted.delete(chatId);
    // At the Mac a new wait stays unalerted, so one still open once the user leaves alerts then.
    if (previous && !away) return;
    for (const [chatId, chat] of waiting) {
      if (alerted.has(chatId) || (previous && !previous.has(chatId))) continue;
      alerted.add(chatId);
      if (previous) deliver(needsYouAlert(chatId, chat));
    }
  }
  async function look() {
    if (!store.notificationRecipients().length) {
      seen = null;
      finished.clear();
      return;
    }
    const waiting = await readWaitingChats();
    if (controller.signal.aborted) return;
    const now = Date.now();
    const { inView, idle } = desktop();
    if (inView) lastInView = now;
    const away = !inView || idle >= AWAY_AFTER_S;
    releaseFinished(waiting, now, idle, away);
    alertNewWaits(waiting, seen, away);
    seen = waiting;
  }
  let looking = false;
  const tick = () => {
    if (looking) return;
    looking = true;
    void look()
      .catch(() => log.warn('[Mobile] Could not check which chats need you.'))
      .finally(() => {
        looking = false;
      });
  };
  const unsubscribe = subscribeSessionCompletions((event) => {
    // A completion published while its chat is still busy is not the chat finishing.
    log.info(
      `[Mobile] Chat ${event.chatId} completed a response (busy=${isBusy(event.subChatId)}).`,
    );
    finished.set(event.chatId, { event, quietAt: 0, quietIdle: 0, looks: 0 });
  });
  // The first look only records what already waits, so it runs now: a wait opening next is new.
  tick();
  const timer = setInterval(tick, LOOK_MS);
  timer.unref();
  return () => {
    unsubscribe();
    clearInterval(timer);
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    pending.clear();
  };
}
