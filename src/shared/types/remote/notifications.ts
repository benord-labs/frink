import { z } from 'zod';

export const pushTokenSchema = z
  .string()
  .max(200)
  .regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/);
export const notificationRegistrationSchema = z
  .object({ token: pushTokenSchema.nullable().optional() })
  .strict();
export const completionNotificationSchema = z.object({
  type: z.literal('session-completed'),
  deviceId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  subChatId: z.string().min(1).max(200),
});
export type NotificationRegistration = z.infer<typeof notificationRegistrationSchema>;
export type NotificationStatus = { enabled: boolean; error: string | null };
