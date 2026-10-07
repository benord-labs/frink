import { z } from 'zod';

export const pushTokenSchema = z
  .string()
  .max(200)
  .regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/);
export const liveActivityTokenSchema = z.string().regex(/^[0-9a-f]{64,400}$/);
export const notificationRegistrationSchema = z
  .object({
    token: pushTokenSchema.nullable().optional(),
    activityToken: liveActivityTokenSchema.nullable().optional(),
  })
  .strict();
const completionNotificationSchema = z.object({
  type: z.literal('session-completed'),
  deviceId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  subChatId: z.string().min(1).max(200),
});
/** A chat (or, without a chatId, a Queue task) is waiting on the user. */
const needsYouNotificationSchema = z.object({
  type: z.literal('needs-you'),
  deviceId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200).optional(),
  subChatId: z.string().min(1).max(200).optional(),
});
/** @public Imported by the mobile app through @frink/shared, which knip does not see. */
export const alertNotificationSchema = z.discriminatedUnion('type', [
  completionNotificationSchema,
  needsYouNotificationSchema,
]);
export type NotificationRegistration = z.infer<typeof notificationRegistrationSchema>;
/** @public Imported by the mobile app through @frink/shared, which knip does not see. */
export type NotificationStatus = { enabled: boolean; error: string | null };
