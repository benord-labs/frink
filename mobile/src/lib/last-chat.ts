import { z } from 'zod';
import type { KeyValue } from './computer-store';

/** The conversation last on screen for one computer, reopened when the app launches. */
const schema = z.object({ id: z.string(), subChatId: z.string().optional() });
export type LastChat = z.infer<typeof schema>;

const keyFor = (deviceId: string) => `frink.mobile.last-chat.v1.${deviceId}`;

export async function readLastChat(store: KeyValue, deviceId: string): Promise<LastChat | null> {
  try {
    const parsed = schema.safeParse(JSON.parse((await store.get(keyFor(deviceId))) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Best effort: a failed save only means the next launch opens the chat list. */
export async function saveLastChat(store: KeyValue, deviceId: string, chat: LastChat | null) {
  try {
    if (chat) await store.set(keyFor(deviceId), JSON.stringify(chat));
    else await store.remove(keyFor(deviceId));
  } catch {}
}
