import { z } from 'zod';
import { isHiddenWakeMessage } from '../../../../../shared/lib/message-markers/hidden-wake-marker';
import type { MessageOrigin } from '../../../../../shared/lib/message-markers/message-provenance';
import type { MessageSendPayload } from '../../client';

/** What main knows about one send; never accepted from a renderer payload. */
export type MessageDelivery = { messageOrigin?: MessageOrigin; dispatchTaskId?: string };

/** The marker a Flow dispatch stamps on its message; the declared metadata type does not carry it. */
const flowDispatchMetadata = z.object({ source: z.literal('flow-dispatch') });

/** Classify the delivery, not the author of a replayed message's body. */
export function classifyMessageOrigin(
  payload: MessageSendPayload,
  messageText: string,
): MessageOrigin {
  if (payload.trigger === 'regenerate-message') return { source: 'internal', kind: 'regenerate' };
  if (payload.approvedPlanContext) return { source: 'internal', kind: 'plan_approval' };
  if (isHiddenWakeMessage(messageText)) return { source: 'internal', kind: 'wake' };
  if (flowDispatchMetadata.safeParse(payload.userMessage.metadata).success)
    return { source: 'flow', kind: 'message' };
  return { source: payload.dispatchTaskId ? 'internal' : 'person', kind: 'message' };
}

export function describeDelivery(
  payload: MessageSendPayload,
  messageText: string,
): MessageDelivery {
  return {
    messageOrigin: classifyMessageOrigin(payload, messageText),
    dispatchTaskId: payload.dispatchTaskId,
  };
}
