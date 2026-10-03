import { alertNotificationSchema } from '@frink/shared/types/remote/notifications';

/**
 * Which paired computer a tapped alert came from, and where it opens there: its chat, or the
 * Queue for a chat-less task. Alerts for a computer this iPhone no longer has are ignored.
 */
export function alertedComputer(data: unknown, deviceIds: readonly string[]) {
  const parsed = alertNotificationSchema.safeParse(data);
  if (!parsed.success || !deviceIds.includes(parsed.data.deviceId)) return null;
  const { deviceId, chatId, subChatId } = parsed.data;
  const target = !chatId
    ? ('queue' as const)
    : subChatId
      ? { id: chatId, subChatId }
      : { id: chatId };
  return { deviceId, target };
}
export type AlertedComputer = NonNullable<ReturnType<typeof alertedComputer>>;
