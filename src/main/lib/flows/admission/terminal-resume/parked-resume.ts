/** A paused run that gave up its slot while it waited for a person takes one back through a resume
 * ticket; once the ticket holds the slot, the step continues in place exactly as it would have. */

import { TRPCError } from '@trpc/server';
import type { FlowResumeTicketAction } from '../../../../../shared/lib/flow-admission';
import type { RecoveryKind } from '../../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../../db';
import { recoveryChangedError, stepRecoveryKind } from '../../rerun/recovery-kind';
import { readRun } from '../../transitions/run-rows';
import { requestTerminalFlowResume, stageResumeBehindHeldAdmission } from '../runtime';
import { ALREADY_RESUMING_MESSAGE } from './continuation';
import type { TerminalResumeAdmission } from './dispatcher';
import {
  ResumeAdmitDeclinedError,
  TerminalResumeAdmissionError,
  TerminalResumeChatDeletedError,
} from './resume-store';

type Db = ReturnType<typeof getDatabase>;

export type ParkedResumeRequest = {
  flowRunId: string;
  nodeRunId: string;
  /** The recovery a Continue or Retry click showed, re-checked when the ticket is claimed. */
  kind?: RecoveryKind;
  /** A Runs-panel action to replay; unset continues the parked task (or advances a settled one). */
  action?: FlowResumeTicketAction;
};

function refusal(error: TerminalResumeAdmissionError): TRPCError {
  const message =
    error instanceof TerminalResumeChatDeletedError
      ? error.message
      : error instanceof ResumeAdmitDeclinedError
        ? 'Flow run changed while it was being resumed.'
        : error.message.includes('different live admission')
          ? ALREADY_RESUMING_MESSAGE
          : 'This Flow step has already changed.';
  return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: error });
}

/** Queue a paused run without its slot to take one back; claimed at once when a slot is free. */
export async function requestParkedFlowResume(
  request: ParkedResumeRequest,
): Promise<TerminalResumeAdmission> {
  const admit = (tx: Db) => {
    if (request.kind && stepRecoveryKind(tx, request.nodeRunId) !== request.kind) {
      throw recoveryChangedError();
    }
    return readRun(tx, request.flowRunId)?.status === 'paused';
  };
  const pending = { ...request, admit };
  try {
    // A release still settling hands its slot straight to this resume.
    if (await stageResumeBehindHeldAdmission(pending, true))
      return { state: 'queued', created: true };
    const { admission, created } = await requestTerminalFlowResume(pending);
    return { state: admission.state, created };
  } catch (error) {
    throw error instanceof TerminalResumeAdmissionError ? refusal(error) : error;
  }
}
