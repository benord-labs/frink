import { z } from 'zod';
import type { NodeOutput } from '../../../../../../shared/types/flow';

const nodeErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Lenient schema: server may add fields; we only require fields we render. */
const nodeOutputSchema = z.object({
  status: z.string(),
  outputs: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.unknown()).optional(),
  error: nodeErrorSchema.optional(),
  durationMs: z.number(),
  signal: z.unknown().optional(),
});

export type ParseNodeOutputResult =
  | { success: true; output: NodeOutput }
  | { success: false; raw: Record<string, unknown> | null };

/**
 * Validates persisted `node_runs.node_output` at the UI boundary.
 * Never cast `Record<string, unknown>` directly to NodeOutput.
 */
export function parseNodeOutput(raw: Record<string, unknown> | null): ParseNodeOutputResult {
  if (raw == null) {
    return { success: false, raw: null };
  }
  const r = nodeOutputSchema.safeParse(raw);
  if (!r.success) {
    return { success: false, raw };
  }
  const d = r.data;
  const output: NodeOutput = {
    status: d.status as NodeOutput['status'],
    outputs: d.outputs,
    artifacts: (d.artifacts ?? []) as NodeOutput['artifacts'],
    error: d.error,
    durationMs: d.durationMs,
    signal: d.signal as NodeOutput['signal'],
  };
  return { success: true, output };
}
