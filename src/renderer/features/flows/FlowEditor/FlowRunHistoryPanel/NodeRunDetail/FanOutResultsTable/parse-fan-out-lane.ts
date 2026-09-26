import { z } from 'zod';
import { deriveFanOutLaneStatus, type FanOutLaneStatus } from '../derive-result-status';

const fanOutErrorSchema = z.object({ message: z.string() });
const fanOutLaneOutputSchema = z
  .object({
    summary: z.unknown().optional(),
    chatId: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .loose();
const fanOutItemSchema = z.record(z.string(), fanOutLaneOutputSchema);

type FanOutLane = {
  laneIndex: number;
  branchRootNodeId: string;
  status: FanOutLaneStatus;
  summary?: string;
  chatId?: string;
  errorMessage?: string;
};

export function parseFanOutItem<T>(item: T, laneIndex: number): FanOutLane[] {
  const parsed = fanOutItemSchema.safeParse(item);
  if (!parsed.success) return [];
  return Object.entries(parsed.data).map(([branchRootNodeId, outputs]) =>
    parseFanOutLane(outputs, laneIndex, branchRootNodeId),
  );
}

/**
 * Parse a single raw fan-out result item (stored as `NodeOutput.outputs` record) into the
 * display-ready shape consumed by ResultRow.
 */
export function parseFanOutLane<T>(item: T, laneIndex: number, branchRootNodeId = ''): FanOutLane {
  const parsed = fanOutLaneOutputSchema.safeParse(item);
  const outputs = parsed.success ? parsed.data : {};

  const status = deriveFanOutLaneStatus(outputs);
  const summary = z.string().safeParse(outputs.summary);
  const chatId = z.string().safeParse(outputs.chatId);
  const stringError = z.string().safeParse(outputs.error);
  const structuredError = fanOutErrorSchema.safeParse(outputs.error);
  const errorMessage = stringError.success
    ? stringError.data
    : structuredError.success
      ? structuredError.data.message
      : undefined;

  return {
    laneIndex,
    branchRootNodeId,
    status,
    summary: summary.success ? summary.data : undefined,
    chatId: chatId.success ? chatId.data : undefined,
    errorMessage,
  };
}
