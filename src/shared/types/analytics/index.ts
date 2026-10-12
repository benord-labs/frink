import { z } from 'zod';

/** A message the user sent from the UI, reported as a count: its length, never its text. */
export const messageSentEventSchema = z.strictObject({
  // Shaped like a local id, so the field cannot carry free text
  workspaceId: z.string().regex(/^[\w-]{1,64}$/),
  messageLength: z.number().int().nonnegative(),
  mode: z.enum(['agent', 'plan', 'debug']),
});

export type MessageSentEvent = z.infer<typeof messageSentEventSchema>;
