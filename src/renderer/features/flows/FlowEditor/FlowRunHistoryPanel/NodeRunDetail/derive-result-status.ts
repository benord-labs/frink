/**
 * Derives a display status for a fan-out result lane from its outputs record.
 *
 * The engine stores each lane's tail-node NodeOutput.outputs directly (not the full NodeOutput
 * wrapper). We infer status from signal state and output fields without parsing summary strings.
 */

export type FanOutLaneStatus = 'passed' | 'failed' | 'skipped' | 'unknown';

/**
 * Map a single fan-out `results[i]` entry (which is the tail node's `outputs` record) to a
 * display status.
 *
 * Priority:
 * 1. `taskStatus === 'needs_attention'` → failed (agent did not signal, timed out or errored)
 * 2. `signal === 'done' | 'completed'` → passed  (only when a run_command script writes signal to stdout)
 * 3. `signal === 'failed'` → failed
 * 4. `signal === 'awaiting_input' | 'blocked' | 'partial'` → unknown (in-progress / paused)
 * 5. Empty object (engine stores `{}` for skipped/unreachable lanes) → skipped
 * 6. `summary` string present but no signal/taskStatus → passed (agent nodes: signal lives on NodeOutput wrapper, not in outputs; summary is the reliable status indicator)
 * 7. Fallback → unknown
 *
 * Note: `outputs.signal` is only set when a run_command script explicitly writes e.g.
 * `{ "signal": "done" }` to stdout. Agent nodes produce their signal on the NodeOutput
 * wrapper (not in `.outputs`), so agent lane status relies on the summary fallback (step 6).
 *
 * Note: we do NOT parse summary strings for status here — that is the critique W1 pattern to avoid.
 */
export function deriveFanOutLaneStatus(outputs: Record<string, unknown>): FanOutLaneStatus {
  if (!outputs || Object.keys(outputs).length === 0) {
    return 'skipped';
  }

  const signal = outputs.signal;
  const taskStatus = outputs.taskStatus;

  if (taskStatus === 'needs_attention') return 'failed';

  if (signal === 'done' || signal === 'completed') return 'passed';
  if (signal === 'failed') return 'failed';
  if (signal === 'awaiting_input' || signal === 'blocked' || signal === 'partial') return 'unknown';

  // If we have a summary but no recognised signal, assume it completed (agent signalled via summary)
  if (typeof outputs.summary === 'string' && outputs.summary.length > 0) {
    return 'passed';
  }

  return 'unknown';
}
