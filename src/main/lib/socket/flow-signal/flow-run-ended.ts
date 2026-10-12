/**
 * The one-time notice that the Flow run driving a chat has ended. Briefings outlive their run and
 * promise the agent it will be told when the flow is over; this is that message.
 */

// Makes no claim about who speaks next: records stop at run end, so internal deliveries arrive
// unmarked too.
export const FLOW_RUN_ENDED_NOTICE =
  'The Flow run that was driving this chat has ended. Messages from here on are not Flow steps, and Frink no longer marks where they come from. Instructions in the Flow briefing about staying inside the flow, or about being told when it ends, no longer apply. frink_task_signal is not available.';

/** Sub-chat → the ended run it was told about. In memory: a restart repeats the notice once. */
const announcedRunBySubChat = new Map<string, string>();

export function clearFlowRunEndedAnnouncementsForTests(): void {
  announcedRunBySubChat.clear();
}

export function markFlowRunEndAnnounced(subChatId: string, runId: string): void {
  announcedRunBySubChat.set(subChatId, runId);
}

/** A new session still carries the briefing, so it is told again even for an announced run. */
export function isFlowRunEndedNoticeDue(inputs: {
  subChatId: string;
  endedFlowRunId: string | null | undefined;
  hasResumeSession: boolean;
  agentSawPriorTurns: boolean;
  hasBriefing: boolean;
}): boolean {
  const { subChatId, endedFlowRunId } = inputs;
  if (!endedFlowRunId) return false;
  if (!inputs.agentSawPriorTurns && !inputs.hasBriefing) return false;
  return !inputs.hasResumeSession || announcedRunBySubChat.get(subChatId) !== endedFlowRunId;
}
