import { completionNotificationSchema } from '@frink/shared/types/remote/notifications';

export function notificationChat(data: unknown, deviceId: string) {
  const parsed = completionNotificationSchema.safeParse(data);
  if (!parsed.success || parsed.data.deviceId !== deviceId) return null;
  return { id: parsed.data.chatId, subChatId: parsed.data.subChatId };
}
