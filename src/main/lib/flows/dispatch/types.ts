/**
 * Shared dispatch types. DispatchContext = everything a per-block dispatcher
 * needs to do its work. DispatchResult = how it tells the engine what happened.
 */

import type { NodeOutput } from '../../../../shared/types/flow';
import type { FlowGraphNode, ParsedFlowGraph } from '../graph';

export type DispatchContext = {
  flowRunId: string;
  nodeRunId: string;
  node: FlowGraphNode;
  /** Output of the immediate predecessor node (undefined for trigger nodes). */
  previousOutput: NodeOutput | undefined;
  /** flow_runs.trigger_context — forwarded into agent / start_task. */
  triggerContext: Record<string, unknown> | null;
  /** Set inside fan_out body chains. */
  loopContext?: Record<string, unknown>;
  /** Parsed graph — needed by fan_out body lookup, validators. */
  parsedGraph: ParsedFlowGraph;
  /** Abort controller for this node — registered in cancel-registry. */
  signal: AbortSignal;
  /**
   * Set only by recovery dispatches, never by engine advances: lets the agent dispatcher continue
   * a session that already answered this step instead of re-sending its instructions.
   */
  resumeKind?: 'continuation';
};

/**
 * Dispatcher contract.
 *
 * - `completed` — node finished synchronously with a NodeOutput; engine advances.
 * - `awaiting_input` — pause the run; `resumeFlowRun` will continue.
 * - `error` — dispatcher itself failed (not the user's command); marked failed.
 *
 * Async-dispatched blocks (e.g. agent SDK calls that emit later via signal-bridge)
 * return `awaiting_input` here; the bridge will call advanceFlowRun once the
 * underlying task completes.
 */
export type DispatchResult =
  | { type: 'completed'; output: NodeOutput }
  /**
   * `handoff` — the node was handed to an async worker (an agent task), so the engine waits on a
   * MACHINE, not on a human: it happens on every node advance and the user has nothing to do.
   * Absent means the run genuinely needs the user before it can continue, which is the only kind
   * of wait worth announcing (decision flow-wait-signal-taxonomy).
   */
  | { type: 'awaiting_input'; reason: string; handoff?: true }
  | { type: 'error'; message: string };

export type Dispatcher = (ctx: DispatchContext) => Promise<DispatchResult>;
