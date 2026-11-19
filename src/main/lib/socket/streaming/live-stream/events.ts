import { EventEmitter } from 'node:events';
import { z } from 'zod';

/** A renderer broadcast seen in-process; `subChatId` is null when the payload names none. */
export type LiveChatEvent = { channel: string; subChatId: string | null };
type LiveChatListener = (event: LiveChatEvent) => void;

const payloadSchema = z.object({ subChatId: z.string().optional() });
const emitter = new EventEmitter<{ chat: [LiveChatEvent] }>();

/** Repeats a renderer broadcast to in-process listeners, such as phones watching a chat. */
export function emitLiveChatEvent<Payload>(channel: string, payload: Payload): void {
  if (!emitter.listenerCount('chat')) return;
  const parsed = payloadSchema.safeParse(payload);
  emitter.emit('chat', { channel, subChatId: (parsed.success && parsed.data.subChatId) || null });
}

export function onLiveChatEvent(listener: LiveChatListener): () => void {
  emitter.on('chat', listener);
  return () => emitter.off('chat', listener);
}
