import type { UIMessageChunk } from '../claude/types';

/** After a non-auto plan submission, drops the model's overrun from history as it is from the live
 * view. Keeps stream-control chunks (the sessionId the approval resumes) and ExitPlanMode's own. */
export function shouldDropPostPlanChunkFromHistory(
  chunk: UIMessageChunk,
  exitPlanModeToolCallId: string | null,
): boolean {
  if (
    chunk.type === 'finish' ||
    chunk.type === 'finish-step' ||
    chunk.type === 'message-metadata'
  ) {
    return false;
  }
  return !(
    'toolCallId' in chunk &&
    exitPlanModeToolCallId !== null &&
    chunk.toolCallId === exitPlanModeToolCallId
  );
}
