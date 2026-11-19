import { z } from 'zod';
import { publicProcedureRaw } from '../../index';

export function flowAttachmentProcedures() {
  return {
    /** Attach a file the agent nodes read by path; the renderer sends where it is, not its bytes. */
    attachFileToRun: publicProcedureRaw
      .input(
        z.object({
          flowId: z.string().min(1),
          runId: z.string().min(1),
          sourcePath: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const { attachFileToStageRun } = await import('../../../flows/attachments-upload');
        return attachFileToStageRun(input);
      }),
  };
}
