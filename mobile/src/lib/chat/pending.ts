import { useSyncExternalStore } from 'react';
import type { MobileMessage, MobileMessagePart } from '@frink/shared/types/remote/mobile';

/** A file stored on the computer for this message; its name and kind draw the chip meanwhile. */
export type PendingFile = { id: string; name: string; kind: 'image' | 'file' };

/**
 * A message tapped on this phone that the transcript doesn't hold yet. Its id is the request id
 * the computer saves the message under, so the first poll that carries it replaces the bubble.
 */
export type PendingEntry = {
  id: string;
  text: string;
  attachments: PendingFile[];
  /** A steer joins the running turn instead of starting one. */
  kind: 'send' | 'steer';
  /** `sent`: the computer took it, and the transcript hasn't shown it yet. */
  state: 'sending' | 'sent' | 'failed';
  error?: string;
  /** A steer's matching Steered notes already in the transcript, which therefore aren't its own. */
  markers?: number;
};
export type PendingMessage = MobileMessage & {
  /** `sent`: a steer the computer holds for the agent's next step. */
  pending?: 'sending' | 'sent' | 'failed';
  error?: string;
};

/** Why a steer failed when the running turn turned it down: nothing reached the agent. */
export const STEER_REFUSED = 'Frink couldn’t take this mid-step, so nothing was sent.';
/** Why a taken steer failed when the turn ended before its Steered note appeared. */
export const STEER_UNREAD = 'Frink finished before it read this.';

const NONE: PendingEntry[] = [];
const store = new Map<string, PendingEntry[]>();
const listeners = new Set<() => void>();

export const pendingKey = (deviceId: string | undefined, chatId: string, subChatId?: string) =>
  `${deviceId}\n${chatId}\n${subChatId}`;

/** Adds an entry, or replaces one with its id in place so a retried bubble keeps its spot. */
export function addPending(entries: PendingEntry[], entry: PendingEntry): PendingEntry[] {
  return entries.some((item) => item.id === entry.id)
    ? entries.map((item) => (item.id === entry.id ? entry : item))
    : [...entries, entry];
}

function patch(entries: PendingEntry[], id: string, change: Partial<PendingEntry>) {
  return entries.map((item) => (item.id === id ? { ...item, ...change } : item));
}

export const markSending = (entries: PendingEntry[], id: string) =>
  patch(entries, id, { state: 'sending', error: undefined });

export const markSent = (entries: PendingEntry[], id: string) =>
  patch(entries, id, { state: 'sent' });

export const markFailed = (entries: PendingEntry[], id: string, error: string) =>
  patch(entries, id, { state: 'failed', error });

export const removePending = (entries: PendingEntry[], id: string) =>
  entries.filter((item) => item.id !== id);

/** The transcript's Steered notes carrying this text, as the steer sent it. */
export function steerMarkers(messages: MobileMessage[], text: string): number {
  const wanted = text.trim();
  return messages.reduce(
    (count, { parts = [] }) =>
      count + parts.filter((part) => part.type === 'steer' && part.text === wanted).length,
    0,
  );
}

/** A taken steer leaves when a Steered note of its own shows, one note per steer in order. */
function reconcileSteer(
  item: PendingEntry,
  messages: MobileMessage[],
  running: boolean,
  claimed: Map<string, number>,
): PendingEntry | null {
  const text = item.text.trim();
  const floor = Math.max(item.markers ?? 0, claimed.get(text) ?? 0);
  // A failed steer may have arrived anyway (its answer lost); a refused one never can.
  const mayShow = item.state !== 'sending' && item.error !== STEER_REFUSED;
  if (mayShow && steerMarkers(messages, text) > floor) {
    claimed.set(text, floor + 1);
    return null;
  }
  const entry = floor === (item.markers ?? 0) ? item : { ...item, markers: floor };
  if (item.state !== 'sent' || running) return entry;
  return { ...entry, state: 'failed', error: STEER_UNREAD };
}

/** Drops entries the computer now holds: messages by id (saved text may differ), steers by note. */
export function reconcile(
  entries: PendingEntry[],
  messages: MobileMessage[],
  running: boolean,
): PendingEntry[] {
  const saved = new Set(messages.map(({ id }) => id));
  const claimed = new Map<string, number>();
  const next = entries.flatMap((item) => {
    if (saved.has(item.id)) return [];
    if (item.kind !== 'steer') return [item];
    const entry = reconcileSteer(item, messages, running, claimed);
    return entry ? [entry] : [];
  });
  return next.length === entries.length && next.every((item, index) => item === entries[index])
    ? entries
    : next;
}

/** A send that may still be on its way: anything typed after it must not start a second turn. */
export const hasUnreconciledSend = (entries: PendingEntry[]) =>
  entries.some(
    (item) => item.kind === 'send' && (item.state === 'sending' || item.state === 'sent'),
  );

function pendingParts({ text, attachments }: PendingEntry): MobileMessagePart[] {
  return [
    ...attachments.map(({ name, kind }): MobileMessagePart => ({ type: 'attachment', name, kind })),
    { type: 'text', text },
  ];
}

function pendingMessage(item: PendingEntry): PendingMessage {
  const message: PendingMessage = {
    id: item.id,
    role: 'user',
    text: item.text,
    pending: item.state === 'sent' && item.kind === 'send' ? 'sending' : item.state,
    error: item.error,
  };
  if (item.attachments.length) message.parts = pendingParts(item);
  return message;
}

/** The transcript as shown: the computer's messages, then this phone's still-unsaved ones. */
export function mergeTranscript(
  server: MobileMessage[],
  entries: PendingEntry[],
): PendingMessage[] {
  const saved = new Set(server.map((message) => message.id));
  const unsaved = entries.filter((item) => !saved.has(item.id)).map(pendingMessage);
  return unsaved.length ? [...server, ...unsaved] : server;
}

export const readPending = (key: string) => store.get(key) ?? NONE;

export function changePending(key: string, change: (entries: PendingEntry[]) => PendingEntry[]) {
  const current = readPending(key);
  const next = change(current);
  if (next === current) return;
  if (next.length) store.set(key, next);
  else store.delete(key);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** One conversation's pending messages. Memory only: a relaunch shows what the computer saved. */
export function usePending(key: string) {
  return useSyncExternalStore(subscribe, () => readPending(key));
}
