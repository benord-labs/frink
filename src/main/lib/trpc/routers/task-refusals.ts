/** Typed task refusals, so the phone's API answers them 404 / 409 and reports only faults. */

import { TRPCError } from '@trpc/server';
import type { TaskMutationFailureReason } from '../../db/repos/tasks';
import type { CarryOnFlowTaskResult } from '../../flows/rerun';

type Refusal = [code: TRPCError['code'], message: string, phoneSafe?: true];

/** An authored refusal whose message the phone may show. Any other TRPCError reaches the phone as
 *  generic text, so new refusal wording stays an explicit choice. */
export class PhoneSafeRefusal extends TRPCError {}

/** Throws the refusal for `reason`; with no reason the failure is a fault, a plain Error. */
export function throwTaskMutationReason(
  reason: TaskMutationFailureReason | undefined,
  messages: {
    notFound: string;
    invalidState: string;
    fallback: string;
    flowShellNotReassignable?: string;
  },
): never {
  const refusals = {
    not_found: ['NOT_FOUND', messages.notFound],
    invalid_state: ['CONFLICT', messages.invalidState],
    flow_shell_not_reassignable: [
      'PRECONDITION_FAILED',
      messages.flowShellNotReassignable ??
        'This task is a flow-linked shell task and cannot be reassigned',
    ],
  } satisfies Record<TaskMutationFailureReason, Refusal>;
  if (!reason) throw new Error(messages.fallback);
  const [code, message] = refusals[reason];
  throw new TRPCError({ code, message });
}

/** Maps a `carryOnFlowTask` failure to its refusal. */
export function throwCarryOnReason(
  reason: Exclude<Extract<CarryOnFlowTaskResult, { ok: false }>['reason'], 'no-session'>,
): never {
  const refusals = {
    'not-found': ['NOT_FOUND', 'Task not found'],
    'invalid-state': ['CONFLICT', 'Only failed or attention-parked tasks can be retried'],
    'chat-archived': [
      'PRECONDITION_FAILED',
      "This task's chat is archived. Restore the chat in Frink to continue it.",
      true,
    ],
    'admission-required': [
      'PRECONDITION_FAILED',
      'This paused Flow lost its place in the run queue. Cancel it and start it again.',
      true,
    ],
    superseded: [
      'CONFLICT',
      'This attempt was replaced by a newer one. Recover from the latest attempt.',
      true,
    ],
  } satisfies Record<typeof reason, Refusal>;
  const [code, message, phoneSafe]: Refusal = refusals[reason];
  throw phoneSafe ? new PhoneSafeRefusal({ code, message }) : new TRPCError({ code, message });
}
