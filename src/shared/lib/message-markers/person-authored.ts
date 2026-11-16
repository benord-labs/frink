import { z } from 'zod';
import { isPlanApprovalTriggerText } from '../../types/plan';
import { TRIGGER_BUBBLE_MARKER } from '../trigger-bubble-marker';
import { isHiddenWakeMessage } from './hidden-wake-marker';

/** Marks a prompt the flow/task pipeline enqueued, in the UIMessage `metadata`, so the send path
 * can tell it from a manual reply (only a manual reply to a parked flow plan approves it). */
export const FLOW_DISPATCH_SOURCE = 'flow-dispatch' as const;

/** Marks a Work Queue task's opening message, in its `metadata`: the task's text came from outside. */
export const WORK_QUEUE_SOURCE = 'work-queue' as const;

/** A message `source` that a flow or the Work Queue stamped, never a person. */
export function isMachineSource(source: string | undefined): boolean {
  return source === FLOW_DISPATCH_SOURCE || source === WORK_QUEUE_SOURCE;
}

/** What a stored user message's metadata says about who sent it; absent on a typed message. */
export const dispatchMetadataSchema = z
  .object({ source: z.string().optional(), dispatchTaskId: z.string().optional() })
  .optional();

type DispatchMetadata = z.infer<typeof dispatchMetadataSchema>;

/** Text Frink wrote, whatever sent it: a wake, a triggered task's opening, a plan approval. */
export function isMachineText(raw: string): boolean {
  return (
    isHiddenWakeMessage(raw) ||
    raw.startsWith(TRIGGER_BUBBLE_MARKER) ||
    isPlanApprovalTriggerText(raw)
  );
}

type AuthoredMessage = { role: string; metadata: DispatchMetadata; text: string };

/** A person wrote this stored message. False whenever a flow, task or Frink itself may have. */
export function isPersonAuthoredMessage({ role, metadata, text }: AuthoredMessage): boolean {
  return (
    role === 'user' &&
    !isMachineSource(metadata?.source) &&
    !metadata?.dispatchTaskId &&
    !isMachineText(text)
  );
}
