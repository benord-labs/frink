import { z } from 'zod';
import { AI_PROVIDER_IDS } from '../../lib/ai-providers';

/** A message the user sent from the UI, reported as a count: its length, never its text. */
export const messageSentEventSchema = z.strictObject({
  // Shaped like a local id, so the field cannot carry free text
  workspaceId: z.string().regex(/^[\w-]{1,64}$/),
  messageLength: z.number().int().nonnegative(),
  mode: z.enum(['agent', 'plan', 'debug']),
});

export type MessageSentEvent = z.infer<typeof messageSentEventSchema>;

/** How an account was connected: the agent's own sign-in, or a pasted API key or token. */
const accountConnectKindSchema = z.enum(['passthrough', 'api_key', 'token']);
export type AccountConnectKind = z.infer<typeof accountConnectKindSchema>;

/** Why connecting an account failed, as a category: never the error's own text. */
const accountConnectFailReasonSchema = z.enum([
  'cli_missing',
  'not_signed_in',
  'access_denied',
  'detection_error',
  'cancelled',
  'unknown',
]);
export type AccountConnectFailReason = z.infer<typeof accountConnectFailReasonSchema>;

/** The renderer reports only a connect page left without connecting; main records the rest. */
export const accountConnectCancelledEventSchema = z.strictObject({
  provider: z.enum(AI_PROVIDER_IDS),
  reason: z.literal('cancelled'),
});
