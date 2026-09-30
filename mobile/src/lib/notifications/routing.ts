import { alertNotificationSchema } from '@frink/shared/types/remote/notifications';

/** Where a tapped alert from the paired Mac opens: its chat, or the Queue for a chat-less task. */
export function notificationTarget(data: unknown, deviceId: string) {
  const parsed = alertNotificationSchema.safeParse(data);
  if (!parsed.success || parsed.data.deviceId !== deviceId) return null;
  const { chatId, subChatId } = parsed.data;
  if (!chatId) return 'queue';
  return subChatId ? { id: chatId, subChatId } : { id: chatId };
}
