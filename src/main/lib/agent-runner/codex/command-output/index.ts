/** Each running Codex command's latest output from `item/commandExecution/outputDelta`, kept as the
 * Codex TUI keeps it: a bounded tail, dropped at item/completed and with the turn holding the map. */

/** Characters kept per command: about the last hundred lines of ordinary output. */
const TAIL_CHARS = 8192;

export type CodexCommandOutput = {
  startedAt: number;
  text: string;
  /** Older output was dropped, so `text` may open mid-line. */
  cut: boolean;
};

/** By command item id, which is also its card's tool call id. */
export type CodexCommandOutputs = Map<string, CodexCommandOutput>;

type Params = {
  item?: { id?: unknown; type?: unknown };
  itemId?: unknown;
  delta?: unknown;
  startedAtMs?: unknown;
};

export function recordCodexCommandOutput(
  outputs: CodexCommandOutputs,
  method: string,
  raw: unknown,
): void {
  const params = (raw ?? {}) as Params;
  if (method === 'item/commandExecution/outputDelta') {
    const output = outputs.get(String(params.itemId));
    if (!output || typeof params.delta !== 'string') return;
    // Trimmed before joining, so one huge chunk never allocates more than the tail it keeps.
    const delta = params.delta.slice(-TAIL_CHARS);
    const text = output.text + delta;
    output.cut ||= text.length > TAIL_CHARS || delta.length < params.delta.length;
    output.text = text.slice(-TAIL_CHARS);
    return;
  }
  if (params.item?.type !== 'commandExecution' || typeof params.item.id !== 'string') return;
  if (method === 'item/started') {
    const at = params.startedAtMs;
    const startedAt = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : Date.now();
    outputs.set(params.item.id, { startedAt, text: '', cut: false });
  } else if (method === 'item/completed') {
    // Its card shows the full output from here on.
    outputs.delete(params.item.id);
  }
}
