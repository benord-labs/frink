import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import { truncateUiString } from '../truncate-ui-string';
import { formatDuration, formatElapsedSinceStartLive } from './format-duration';
import { parseNodeOutput } from './NodeRunDetail/parse-node-output';
import { wallDurationMs } from './wall-duration-ms';

/** Tooltip copy for a node run row (keyboard + hover). Pass `nowMs` while running for live elapsed (matches expanded row). */
export function getNodeRunTooltipText(nr: DbNodeRun, nowMs?: number): string {
  const { status, started_at, completed_at, node_output } = nr;

  if (status === 'running') {
    const elapsed = formatElapsedSinceStartLive(started_at, nowMs ?? Date.now());
    return elapsed ? `Running for ${elapsed}` : 'Running…';
  }
  if (status === 'awaiting_input') {
    return 'Awaiting input';
  }
  if (status === 'blocked') {
    return 'Blocked';
  }
  if (status === 'pending') {
    return 'Pending';
  }

  if (status === 'failed') {
    const parsed = parseNodeOutput(node_output);
    let msg = '';
    let exitCode: unknown;
    if (parsed.success && parsed.output.error?.message?.trim()) {
      msg = parsed.output.error.message.trim();
      exitCode = parsed.output.outputs?.exitCode;
    } else if (parsed.success) {
      exitCode = parsed.output.outputs?.exitCode;
    } else if (node_output && typeof node_output === 'object') {
      const err = (node_output as Record<string, unknown>).error;
      if (err && typeof err === 'object' && 'message' in err) {
        const m = (err as { message?: unknown }).message;
        if (typeof m === 'string' && m.trim()) msg = m.trim();
      }
    }
    const parts: string[] = [];
    if (msg) parts.push(truncateUiString(msg, 220));
    if (exitCode != null && exitCode !== '') {
      parts.push(`Exit code: ${String(exitCode)}`);
    }
    if (parts.length === 0) return 'Failed';
    return parts.join('\n');
  }

  if (status === 'completed') {
    const ms = wallDurationMs(started_at, completed_at);
    if (ms != null && ms >= 0) {
      return `Completed in ${formatDuration(ms)}`;
    }
    return 'Completed';
  }

  if (status === 'cancelled') {
    return 'Cancelled';
  }
  if (status === 'skipped') {
    return 'Skipped';
  }

  return status;
}
