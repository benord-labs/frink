/**
 * advanceFlowRun — applies a node's NodeOutput, picks the next node, dispatches it, and repeats
 * until a terminal or paused node. A loop, not a recursion: a finished node holds no frame, output
 * or abort controller while later nodes run. Fan Out branches each get a walk of their own.
 */

import log from 'electron-log';
import type { NodeOutput } from '../../../shared/types/flow';
import type { FlowResumeSnapshot } from '../../../shared/types/flow-run/resume';
import { getDatabase } from '../db';
import { setNodeRunStatus } from '../db/repos/node-runs';
import { captureContained } from '../sentry';
import {
  type DispatchOptions,
  endRun,
  type NextDispatch,
  nextDispatchesAfter,
} from './advance-walk';
import { registerNodeAbort, unregisterNodeAbort } from './cancel-registry';
import { dispatchNode } from './dispatch';
import { emitNodeStarted, emitRunPaused } from './event-emit';
import { buildLoopContextFor } from './fan-out-step';
import { loadRunContext, loadRunMeta, type RunContext } from './advance-walk/run-context';
import { withSlot } from './scheduler';
import {
  insertNodeRunIfFenced,
  type RunFence,
  readRunFence,
  runTransition,
  setFencedRunStatus,
} from './transitions';

export { loadRunContext, type RunContext } from './advance-walk/run-context';

type Db = ReturnType<typeof getDatabase>;

/** Long in-process walks (a condition loop) hand the event loop a turn this often, so a Cancel
 * can land; ordinary flows never reach it. */
const HOPS_PER_EVENT_LOOP_TURN = 100;

function failedOutput(message: string): NodeOutput {
  return {
    status: 'failed',
    outputs: {},
    artifacts: [],
    durationMs: 0,
    error: { message, retryable: false },
  };
}

async function dispatchNodeUnlessAborted(
  controller: AbortController,
  input: Parameters<typeof dispatchNode>[0],
) {
  if (controller.signal.aborted) return null;
  const result = await withSlot(async () => {
    if (controller.signal.aborted) return null;
    return dispatchNode(input);
  });
  return controller.signal.aborted ? null : result;
}

function parkAwaitingInput(
  db: Db,
  fence: RunFence,
  nodeRunId: string,
  controller: AbortController,
): boolean {
  const parked = setNodeRunStatus(db, nodeRunId, 'awaiting_input', {
    completedAt: new Date(),
    expectStatuses: ['running'],
  });
  if (!parked || controller.signal.aborted) return false;
  return setFencedRunStatus(db, fence, 'paused') !== null;
}

/** The run's event meta when its context could not be loaded. Null, never a throw, when the rows
 * cannot be read either: the run is then failed in the database with no event. */
async function loadMetaContained(fence: RunFence) {
  try {
    return await loadRunMeta(fence.flowRunId);
  } catch (err) {
    log.error('[FlowsEngine] run meta unreadable, failing the run without an event', {
      flowRunId: fence.flowRunId,
      err,
    });
    return null;
  }
}

/** Fails the run without ever rejecting: this is the last resort of a catch. */
async function failRunContained(
  db: Db,
  fence: RunFence,
  ctx: RunContext | null,
  message: string,
): Promise<void> {
  try {
    await endRun(db, fence, 'failed', ctx?.meta ?? (await loadMetaContained(fence)), message);
  } catch (endErr) {
    // endRun writes the status first, so the run is failed even when its sweep or emit throws.
    log.error('[FlowsEngine] failing the run after an advance threw also threw', {
      flowRunId: fence.flowRunId,
      err: endErr,
    });
  }
}

type AppliedOutput = {
  /** False ONLY when a guard was asked for and nothing was written. */
  advanced: boolean;
  /** Present when there is something to dispatch next. */
  continuation?: { fence: RunFence; ctx: RunContext; next: NextDispatch[] };
};

/** Persist a node's NodeOutput, emit the matching event, and work out what runs next. */
async function applyNodeOutput(
  flowRunId: string,
  nodeRunId: string,
  output: NodeOutput,
  drivingTask?: { id: string; status: string; result: unknown },
  resumeSnapshot?: FlowResumeSnapshot,
): Promise<AppliedOutput> {
  const db = getDatabase();
  // Never write into a terminal run. Every write below re-checks this fence, so a Cancel (or a
  // Cancel and a Retry under a new ticket) landing across an await makes it decline.
  const fence = readRunFence(db, flowRunId);
  if (!fence) return { advanced: true };

  // CAS guard: only advance when the node_run is still active. A re-advance of an
  // already-terminal node (e.g. the watcher re-firing a completed task after a restart
  // wiped its in-memory dedup) matches 0 rows here and bails BEFORE re-walking edges —
  // the fix for duplicate downstream dispatch. Mirrors the cloud engine's status-IN CAS.
  const updated = await setNodeRunStatus(db, nodeRunId, output.status, {
    nodeOutput: output,
    completedAt: new Date(),
    expectStatuses: ['running', 'awaiting_input', 'blocked'],
    expectDrivingTask: drivingTask,
    expectResumeSnapshot: resumeSnapshot,
  });
  if (!updated) return { advanced: !drivingTask && !resumeSnapshot };

  let ctx: RunContext | null = null;
  try {
    ctx = await loadRunContext(flowRunId);
    if (!ctx) return { advanced: true };
    const next = await nextDispatchesAfter(db, fence, updated, output, ctx);
    return next.length > 0
      ? { advanced: true, continuation: { fence, ctx, next } }
      : { advanced: true };
  } catch (err) {
    // The node is already written, so it cannot be failed in the run's place: fail the run.
    const message = err instanceof Error ? err.message : String(err);
    log.error('[FlowsEngine] advance threw after the node write', {
      flowRunId,
      nodeId: updated.nodeId,
      blockType: updated.blockType,
      err,
    });
    captureContained(err, { surface: 'flow-advance', blockType: updated.blockType });
    await failRunContained(db, fence, ctx, message);
    return { advanced: true };
  }
}

/** Insert node_run, register abort, dispatch. Returns the output to apply, or null when there is
 * nothing to apply: the insert declined, the node was aborted, or it parked awaiting input. */
async function dispatchOnce(
  fence: RunFence,
  step: NextDispatch,
  ctx: RunContext,
): Promise<{ nodeRunId: string; output: NodeOutput } | null> {
  const db = getDatabase();
  const { flowRunId } = fence;
  const { node, previousOutput, options } = step;
  // Inject fan_out loopContext when this node is part of a body chain, unless
  // the caller already supplied one (the iteration-step path passes it through
  // explicitly to avoid an extra KV roundtrip).
  const loopContext = step.loopContext ?? (await buildLoopContextFor(flowRunId, node.id));

  // The insert and the abort registration share one tick: a Cancel that commits first makes the
  // insert decline, and one that commits later finds this controller to abort.
  const inserted = runTransition(db, () =>
    insertNodeRunIfFenced(
      db,
      fence,
      {
        nodeId: node.id,
        blockType: node.blockType,
        status: 'running',
        startedAt: new Date(),
        laneIndex: options?.laneIndex,
        parentFanOutNodeRunId: options?.parentFanOutNodeRunId,
      },
      options?.supersedesNodeRunId,
    ),
  );
  if (!inserted) return null;
  const controller = new AbortController();
  registerNodeAbort(flowRunId, controller);

  // Nothing may run between registering and the try: the finally is what unregisters, and a
  // node_started listener can throw (flowEventBus is a plain EventEmitter).
  try {
    emitNodeStarted(ctx.meta, flowRunId, node.id, node.blockType, node.label);
    const result = await dispatchNodeUnlessAborted(controller, {
      flowRunId,
      nodeRunId: inserted.id,
      node: { id: node.id, blockType: node.blockType, label: node.label, config: node.config },
      previousOutput,
      triggerContext: ctx.triggerContext,
      loopContext,
      parsedGraph: ctx.graph,
      signal: controller.signal,
      resumeKind: options?.resumeKind,
    });
    if (!result) return null;

    if (result.type === 'awaiting_input') {
      if (!parkAwaitingInput(db, fence, inserted.id, controller)) return null;
      // An agent hand-off waits on the machine and happens on every advance; an approval block
      // (or a merge conflict) waits on the user. Only the latter is user-facing signal.
      emitRunPaused(
        ctx.meta,
        flowRunId,
        { [node.id]: { status: 'awaiting_input' } },
        result.handoff ? 'agent-handoff' : undefined,
      );
      return null;
    }
    if (result.type === 'error') {
      return { nodeRunId: inserted.id, output: failedOutput(result.message) };
    }
    return { nodeRunId: inserted.id, output: result.output };
  } catch (err) {
    // A dispatcher that THROWS must still terminalize its node. Without this the run sits in
    // 'running' forever: the trigger entry point is `void runFlow(...).catch(log.error)`
    // (start.ts), so the only trace is one log line and the user sees a hung flow.
    //
    // An abort is NOT a failure: whoever aborted this controller owns the run's terminal state.
    if (controller.signal.aborted) return null;

    const message = err instanceof Error ? err.message : String(err);
    log.error('[FlowsEngine] node dispatch threw', {
      flowRunId,
      nodeId: node.id,
      blockType: node.blockType,
      err,
    });
    // The run is terminalized below, so nothing downstream ever reports this — a dispatcher
    // crashing for every user would otherwise show up only as failed runs with no cause.
    captureContained(err, { surface: 'flow-dispatch', blockType: node.blockType });
    return { nodeRunId: inserted.id, output: failedOutput(message) };
  } finally {
    // Released as soon as this node settles, not when the walk after it does.
    unregisterNodeAbort(flowRunId, controller);
  }
}

/** Applies a dispatched node's output. If recording it throws before anything is written, the
 * node is still 'running', so the failure is recorded as its outcome instead. */
async function applyDispatchedOutput(
  flowRunId: string,
  step: NextDispatch,
  dispatched: { nodeRunId: string; output: NodeOutput },
): Promise<AppliedOutput> {
  try {
    return await applyNodeOutput(flowRunId, dispatched.nodeRunId, dispatched.output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[FlowsEngine] recording a node output threw', {
      flowRunId,
      nodeId: step.node.id,
      blockType: step.node.blockType,
      err,
    });
    captureContained(err, { surface: 'flow-dispatch', blockType: step.node.blockType });
    return applyNodeOutput(flowRunId, dispatched.nodeRunId, failedOutput(message));
  }
}

/** Applies a dispatched node's output without ever rejecting. If recording the failure throws as
 * well, the node cannot carry it, so the run is failed and the walk ends there. */
async function applyOutputOrFailRun(
  fence: RunFence,
  ctx: RunContext,
  step: NextDispatch,
  dispatched: { nodeRunId: string; output: NodeOutput },
): Promise<AppliedOutput> {
  try {
    return await applyDispatchedOutput(fence.flowRunId, step, dispatched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[FlowsEngine] recording a failed node output also threw', {
      flowRunId: fence.flowRunId,
      nodeId: step.node.id,
      blockType: step.node.blockType,
      err,
    });
    captureContained(err, { surface: 'flow-advance', blockType: step.node.blockType });
    await failRunContained(getDatabase(), fence, ctx, message);
    return { advanced: true };
  }
}

/** Dispatches `steps` and everything that follows them. A single successor continues in the
 * loop; several (Fan Out branches) each get a walk of their own, awaited together. */
async function walk(
  startFence: RunFence,
  startCtx: RunContext,
  startSteps: NextDispatch[],
): Promise<void> {
  let fence = startFence;
  let ctx = startCtx;
  let steps = startSteps;
  let hops = 0;
  while (steps.length === 1) {
    const [step] = steps;
    let dispatched: Awaited<ReturnType<typeof dispatchOnce>>;
    try {
      dispatched = await dispatchOnce(fence, step, ctx);
    } catch (err) {
      // Thrown before the node run existed (loop-context load, the insert), so there is no node to
      // fail: fail the run, or the node before it stays 'completed' with nothing left to move it.
      const message = err instanceof Error ? err.message : String(err);
      log.error('[FlowsEngine] starting a node threw', {
        flowRunId: fence.flowRunId,
        nodeId: step.node.id,
        blockType: step.node.blockType,
        err,
      });
      captureContained(err, { surface: 'flow-advance', blockType: step.node.blockType });
      await failRunContained(getDatabase(), fence, ctx, message);
      return;
    }
    if (!dispatched) return;
    const applied = await applyOutputOrFailRun(fence, ctx, step, dispatched);
    if (!applied.continuation) return;
    ({ fence, ctx, next: steps } = applied.continuation);

    hops += 1;
    if (hops % HOPS_PER_EVENT_LOOP_TURN === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  await Promise.all(steps.map((step) => walk(fence, ctx, [step])));
}

/**
 * Persist a node's NodeOutput, emit the matching event, then walk forward through the nodes that
 * complete in-process. Resolves once the walk ends, pauses, or hands off to an agent.
 */
export async function advanceFlowRun(
  flowRunId: string,
  nodeRunId: string,
  output: NodeOutput,
  /** Watcher-only: the driving-task row the output was derived from. The node write is refused
   * when that exact row is gone (resumed, or resumed and re-parked) — see setNodeRunStatus. */
  drivingTask?: { id: string; status: string; result: unknown },
  resumeSnapshot?: FlowResumeSnapshot,
): Promise<boolean> {
  const applied = await applyNodeOutput(flowRunId, nodeRunId, output, drivingTask, resumeSnapshot);
  if (applied.continuation) {
    const { fence, ctx, next } = applied.continuation;
    await walk(fence, ctx, next);
  }
  return applied.advanced;
}

/** Dispatch `node`, then walk forward from it. */
export async function dispatchAndAdvance(
  fence: RunFence,
  node: NextDispatch['node'],
  previousOutput: NodeOutput | undefined,
  ctx: RunContext,
  explicitLoopContext?: NextDispatch['loopContext'],
  options?: DispatchOptions,
): Promise<void> {
  await walk(fence, ctx, [{ node, previousOutput, loopContext: explicitLoopContext, options }]);
}
