/** Removes one attachment from a pending batch stage run by URL. The file stays: dispatch may
 * already have copied the entry, and the run's folder is swept when the run is deleted. */

import { TRPCError } from '@trpc/server';
import { getDatabase } from '../../db';
import {
  type RemovableTriggerContext,
  removeStageRunAttachment,
} from '../../db/repos/batch-stage-runs';

type RemoveInput = { runId: string; url: string };

type RemoveResult = { run: { id: string; trigger_context: RemovableTriggerContext } };

export function removeAttachmentFromStageRun(
  input: RemoveInput,
  db: ReturnType<typeof getDatabase> = getDatabase(),
): RemoveResult {
  const result = removeStageRunAttachment(db, input.runId, input.url);
  if (!result.ok) {
    if (result.reason === 'not_pending') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Images can only be removed before the run starts',
      });
    }
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }
  return { run: { id: input.runId, trigger_context: result.triggerContext } };
}
