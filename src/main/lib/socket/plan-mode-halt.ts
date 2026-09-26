import type { UIMessageChunk } from '../claude/types';

/**
 * Post-plan history filter (non-auto plan only). Once ExitPlanMode completes, the turn is halted
 * for user approval — chunks the model races in before the interrupt lands are hidden from the
 * live stream, so they must stay out of persisted history too (reload view must equal live view).
 * Stream-control chunks still persist: `finish` carries the sessionId/metadata the approval-resume
 * path requires, and the ExitPlanMode output itself stays (the canonical-plan filters hide its row).
 */
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

/**
 * The halt-for-approval interrupt ends the SDK turn with a non-success result subtype, but the
 * turn IS a successful plan submission — surface it as such (the usage badge renders this field).
 */
export function normalizePlanHaltFinishChunk(chunk: UIMessageChunk): UIMessageChunk {
  if (chunk.type !== 'finish' && chunk.type !== 'message-metadata') return chunk;
  const metadata = chunk.messageMetadata as { resultSubtype?: string } | undefined;
  if (!metadata || metadata.resultSubtype === 'success') return chunk;
  return { ...chunk, messageMetadata: { ...metadata, resultSubtype: 'success' } } as UIMessageChunk;
}
