import { z } from 'zod';

/** Internal resume precondition; mobile callers receive only its opaque action token. */
export const flowResumeSnapshotSchema = z.object({
  status: z.string(),
  nodeOutput: z.unknown(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  attemptIds: z.array(z.string()).min(1),
  drivingTask: z.object({ id: z.string(), status: z.string(), result: z.unknown() }).optional(),
  plan: z.object({ subChatId: z.string(), messages: z.array(z.unknown()) }).optional(),
});

export type FlowResumeSnapshot = z.infer<typeof flowResumeSnapshotSchema>;
