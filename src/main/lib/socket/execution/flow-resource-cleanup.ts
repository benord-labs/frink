import log from 'electron-log';
import type { getDatabase } from '../../db';
import {
  beginFlowResourceActivity,
  type FlowResourceActivityRelease,
} from '../../flows/admission/activity';
import type { PendingContinuationResume } from '../../flows/admission/terminal-resume/continuation';
import type { ClaudeSession } from '../claude-session-registry';
import { releaseWakeHold } from '../claude-wake-hold';
import type { AgentRuntime } from '../runtime-gate';
import { disposeClaudeSessionAndWait } from './claude-provider-cleanup';
import { hasReusableWakeHoldRuntimeSlot } from './wake-hold-registry-view';

export type FlowForegroundCleanup = {
  subChatId: string;
  resourcesTransferredToWakeHold: boolean;
  session: ClaudeSession | null;
  executionContextId: string | undefined;
  clearExecutionContext: (executionContextId: string) => unknown | Promise<unknown>;
  executionController: AbortController | null;
  getActiveController: () => AbortController | undefined;
  deleteAbortSource: () => unknown;
  clearPendingApprovals: () => unknown;
  providerSettlements: readonly Promise<void>[];
  finalizeLinkedTaskSignal: () => Promise<void>;
  deleteActiveExecution: () => unknown;
  chatId: string | undefined;
  flowContinuationClearId: string | null;
  clearFlowContinuation: (chatId: string, taskId: string) => unknown | Promise<unknown>;
  cleanupRuntime: (() => unknown | Promise<unknown>) | null;
  unregisterFlowRunAbort: () => unknown;
  release: FlowResourceActivityRelease;
};

export type { FlowResourceActivityRelease } from '../../flows/admission/activity';

type FlowResourceProvenance = {
  prefetchedSignalTask: {
    id?: string;
    flowRunId?: string | null;
    source?: string | null;
    status?: string;
  } | null;
  provenanceLookupError: { cause: unknown } | null;
  restartInterruptedFlowRunId: string | null;
  effectiveSignalTaskId?: string | null;
  taskSignalDisarmed: boolean;
};
const flowTaskTeardownPersistence = new WeakMap<AbortController, Promise<void>>();
/** abortActiveExecutionsForSubChats reasons for removing the turn's own chat: like a Cancel,
 * they drop its typed-reply continuation. */
const CHAT_REMOVAL_ABORTS = new Set([
  'chat deleted',
  'chat archived',
  'chat archived (batch)',
  'project deleted',
]);
async function reconcileFlowTaskOnTeardown(subChatId: string, interrupted: boolean): Promise<void> {
  try {
    const { getDatabase } = await import('../../db');
    const { cancelFlowTaskForSubChat } = await import('../../db/repos/tasks');
    const taskId = await cancelFlowTaskForSubChat(getDatabase(), subChatId, { interrupted });
    if (taskId) {
      log.info(
        `[Socket Executor] reconciled flow task ${taskId} for torn-down sub-chat ${subChatId} (interrupted=${interrupted})`,
      );
    }
  } catch (error) {
    log.warn(`[Socket Executor] flow-task reconcile failed for ${subChatId}:`, error);
    throw error;
  }
}
export function startFlowTaskTeardown(
  subChatId: string,
  interrupted: boolean,
  controller?: AbortController,
): Promise<void> {
  const persistence = reconcileFlowTaskOnTeardown(subChatId, interrupted);
  // Settlement awaits the original promise; this handler only prevents an early unhandled rejection.
  void persistence.catch(() => {});
  if (controller) flowTaskTeardownPersistence.set(controller, persistence);
  return persistence;
}
async function awaitFlowTaskTeardown(controller: AbortController | null): Promise<void> {
  if (!controller) return;
  const persistence = flowTaskTeardownPersistence.get(controller);
  if (!persistence) return;
  try {
    await persistence;
  } finally {
    if (flowTaskTeardownPersistence.get(controller) === persistence) {
      flowTaskTeardownPersistence.delete(controller);
    }
  }
}
export function resolveFlowResourceRunId(provenance: FlowResourceProvenance): string | null {
  if (provenance.taskSignalDisarmed) return null;
  const durableFlowTaskRunId =
    provenance.prefetchedSignalTask?.source === 'flow'
      ? provenance.prefetchedSignalTask.flowRunId
      : null;
  return durableFlowTaskRunId ?? provenance.restartInterruptedFlowRunId;
}

export type FlowProviderExecutionRegistration = {
  release: FlowResourceActivityRelease;
  rebindAbort: (controller: AbortController) => void;
  unregisterAbort: () => void;
  prepareAndValidate: (prepareForExecution: () => Promise<void>) => Promise<void>;
  /**
   * The continuation re-admission a FLOW_RUN_RESUMING decline recorded, if any. The
   * executor stages it (stageContinuationResume) before settling this turn; the run's
   * final activity release fires it once the prior admission has actually settled.
   * `abortReason` is the turn's stamped abort source, if it was aborted.
   */
  takePendingContinuationResume: (abortReason?: string) => PendingContinuationResume | null;
};

export type FlowProviderExecutionInput = {
  provenance: FlowResourceProvenance;
  expectedFlowTaskId?: string;
  controller: AbortController;
  /** Parent chat of the send — required for the typed-reply continuation gate. */
  chatId?: string;
};

type FlowProviderIdentity = {
  flowRunId: string;
  canonicalTaskId: string;
};

type FlowTaskCandidate = FlowResourceProvenance['prefetchedSignalTask'];

function resolveDurableProviderIdentity(
  provenance: FlowResourceProvenance,
): FlowProviderIdentity | null {
  const flowRunId = resolveFlowResourceRunId(provenance);
  if (!flowRunId) return null;
  const canonicalTaskId =
    provenance.prefetchedSignalTask?.id ?? provenance.effectiveSignalTaskId ?? undefined;
  if (!canonicalTaskId) {
    throw new Error('Flow task unknown is no longer execution-eligible');
  }
  return { flowRunId, canonicalTaskId };
}

function identityFromExpectedTask(
  task: FlowTaskCandidate,
  expectedTaskId: string,
): FlowProviderIdentity | null {
  if (!task || task.id !== expectedTaskId) {
    throw new Error(`Expected Flow task ${expectedTaskId} has no durable run provenance`);
  }
  if (task.source !== 'flow') return null;
  if (!task.flowRunId) {
    throw new Error(`Expected Flow task ${expectedTaskId} has no durable run provenance`);
  }
  return { flowRunId: task.flowRunId, canonicalTaskId: expectedTaskId };
}

async function resolveFlowProviderIdentity(
  params: FlowProviderExecutionInput,
): Promise<FlowProviderIdentity | null> {
  if (!params.expectedFlowTaskId) return resolveDurableProviderIdentity(params.provenance);
  const prefetchedTask = params.provenance.prefetchedSignalTask;
  if (prefetchedTask?.id === params.expectedFlowTaskId) {
    return identityFromExpectedTask(prefetchedTask, params.expectedFlowTaskId);
  }
  const { getDatabase } = await import('../../db');
  const { getTaskById } = await import('../../db/repos/tasks');
  const identifyingTask = await getTaskById(getDatabase(), params.expectedFlowTaskId);
  return identityFromExpectedTask(identifyingTask, params.expectedFlowTaskId);
}

function isEligibleFlowTask(
  task: FlowTaskCandidate,
  identity: FlowProviderIdentity,
  drivingStatuses: readonly string[],
): boolean {
  return (
    task?.source === 'flow' &&
    task.flowRunId === identity.flowRunId &&
    drivingStatuses.includes(task.status ?? '')
  );
}

function isActiveFlowAdmission(
  run: { status: string } | null | undefined,
  admission: { state: string } | null | undefined,
): boolean {
  return Boolean(
    run && ['running', 'paused'].includes(run.status) && admission?.state === 'active',
  );
}

/**
 * Typed-reply decline-and-convert gate: a declined send into a failed/cancelled
 * run whose surviving session still holds the resume target's turn converts into a
 * durable continuation re-admission (recorded here, staged by the executor pre-settle,
 * fired by the admission lifecycle once the prior admission settles).
 * Completed runs keep the plain decline — their resume anchor is graph-shape-dependent
 * (rerun/resume-point falls back to the first node after start_task), so typed-reply v1
 * covers failed/cancelled only.
 */
async function resolveContinuationConversion(
  db: ReturnType<typeof getDatabase>,
  identity: FlowProviderIdentity,
  chatId: string | undefined,
  run: { status: string } | null | undefined,
): Promise<PendingContinuationResume | null> {
  if (!chatId || !run || !['failed', 'cancelled'].includes(run.status)) return null;
  try {
    const { resolveTerminalResumeTarget } =
      await import('../../flows/admission/terminal-resume/dispatcher');
    const { resolveSessionResumeSeed } = await import('../../flows/rerun/session-resume');
    const target = await resolveTerminalResumeTarget(db, identity.flowRunId);
    if (!target) return null;
    const seed = await resolveSessionResumeSeed(db, {
      chatId,
      flowRunId: identity.flowRunId,
      nodeId: target.node.id,
      configuredStartMode: undefined,
    });
    return seed ? { flowRunId: identity.flowRunId, nodeRunId: target.nodeRunId } : null;
  } catch (error) {
    log.warn(
      `[Socket Executor] typed-reply continuation gate failed for ${identity.flowRunId}:`,
      error,
    );
    return null;
  }
}

async function assertFlowProviderEligible(
  identity: FlowProviderIdentity,
  controller: AbortController,
  chatId: string | undefined,
  recordContinuation: (pending: PendingContinuationResume) => void,
): Promise<void> {
  const { getDatabase } = await import('../../db');
  const { getTaskById } = await import('../../db/repos/tasks');
  const { getFlowRun } = await import('../../db/repos/flow-runs');
  const { liveAdmissionForRun } = await import('../../flows/admission/store');
  const { FLOW_DRIVING_STATUSES } = await import('../../../../shared/types/flow');
  const db = getDatabase();
  const [canonicalTask, run] = await Promise.all([
    getTaskById(db, identity.canonicalTaskId),
    getFlowRun(db, identity.flowRunId),
  ]);
  const admission = liveAdmissionForRun(db, identity.flowRunId);
  if (controller.signal.aborted) {
    throw new Error(`Flow run ${identity.flowRunId} was cancelled before provider preflight`);
  }
  // FLOW_RUN_ENDED / FLOW_RUN_RESUMING mark these two declines as EXPECTED (a send into a run
  // whose task/admission already settled — e.g. typed into an interrupted flow chat): the
  // renderer's category registries turn them into an actionable toast instead of an execution
  // failure that rolls the user's message back and persists a doomed retry. RESUMING is the
  // decline-and-convert variant: the typed message will continue the run once the executor
  // fires the recorded re-admission after this turn settles. The provenance throws above stay
  // uncategorized on purpose — those are internal defects, not ended runs.
  const declineEndedRun = async (message: string): Promise<never> => {
    const conversion = await resolveContinuationConversion(db, identity, chatId, run);
    if (conversion) {
      recordContinuation(conversion);
      throw Object.assign(new Error(message), { category: 'FLOW_RUN_RESUMING' });
    }
    throw Object.assign(new Error(message), { category: 'FLOW_RUN_ENDED' });
  };
  if (!isEligibleFlowTask(canonicalTask, identity, FLOW_DRIVING_STATUSES)) {
    await declineEndedRun(`Flow task ${identity.canonicalTaskId} is no longer execution-eligible`);
  }
  if (!isActiveFlowAdmission(run, admission)) {
    await declineEndedRun(
      `Flow run ${identity.flowRunId} is no longer admitted for provider execution`,
    );
  }
}

/**
 * Establish Flow ownership before credential, runtime-slot, or provider work. Registration makes
 * later cancellation abort this turn; the returned provider seam revives restart work only after
 * provider preparation and validation, then closes the cancellation race with a canonical read.
 */
export async function registerFlowProviderExecution(
  params: FlowProviderExecutionInput,
): Promise<FlowProviderExecutionRegistration | null> {
  if (params.provenance.provenanceLookupError !== null) {
    throw params.provenance.provenanceLookupError.cause;
  }

  const identity = await resolveFlowProviderIdentity(params);
  if (!identity) return null;

  const [{ registerNodeAbort, unregisterNodeAbort }, { continuationDropGeneration }] =
    await Promise.all([
      import('../../flows/cancel-registry'),
      import('../../flows/admission/terminal-resume/continuation'),
    ]);
  registerNodeAbort(identity.flowRunId, params.controller);
  const dropGeneration = continuationDropGeneration(identity.flowRunId);
  const release = beginFlowResourceActivity(identity.flowRunId);
  let registeredController: AbortController | null = params.controller;
  const rebindAbort = (controller: AbortController): void => {
    if (!registeredController || registeredController === controller) return;
    const previousController = registeredController;
    registerNodeAbort(identity.flowRunId, controller);
    // A Cancel may have aborted the old controller while the provider was still unwinding it.
    // Never let a replacement revive that turn.
    if (previousController.signal.aborted) controller.abort();
    unregisterNodeAbort(identity.flowRunId, previousController);
    registeredController = controller;
  };
  const unregisterAbort = (): void => {
    if (!registeredController) return;
    unregisterNodeAbort(identity.flowRunId, registeredController);
    registeredController = null;
  };
  let providerPreflight: Promise<void> | null = null;
  let pendingContinuationResume: PendingContinuationResume | null = null;
  const prepareAndValidate = (prepareForExecution: () => Promise<void>): Promise<void> => {
    providerPreflight ??= (async () => {
      const controller = registeredController;
      if (!controller || controller.signal.aborted) {
        throw new Error(`Flow run ${identity.flowRunId} was cancelled before provider preparation`);
      }
      await prepareForExecution();
      const preparedController = registeredController;
      if (!preparedController) {
        throw new Error(
          `Flow run ${identity.flowRunId} lost provider ownership during preparation`,
        );
      }
      await assertFlowProviderEligible(identity, preparedController, params.chatId, (pending) => {
        pendingContinuationResume = pending;
      });
    })();
    return providerPreflight;
  };
  const takePendingContinuationResume = (
    abortReason?: string,
  ): PendingContinuationResume | null => {
    const pending = pendingContinuationResume;
    pendingContinuationResume = null;
    // A Cancel or Flow deletion since registration, or removing this turn's own chat, drops it.
    const dropped = continuationDropGeneration(identity.flowRunId) !== dropGeneration;
    return dropped || CHAT_REMOVAL_ABORTS.has(abortReason ?? '') ? null : pending;
  };
  return {
    release,
    rebindAbort,
    unregisterAbort,
    prepareAndValidate,
    takePendingContinuationResume,
  };
}
/** Consumes the provider preflight's activity token before joining the runtime queue. */
export async function acquireExecutorRuntimeSlot(
  runtime: AgentRuntime,
  mode: string,
  subChatId: string,
  acquireRuntimeSlot: () => Promise<() => void>,
  flowResourceActivityRelease: FlowResourceActivityRelease | null,
): Promise<{
  runtimeSlotRelease: (() => void) | null;
  flowResourceActivityRelease: FlowResourceActivityRelease | null;
}> {
  const hasHeldClaudeSlot = hasReusableWakeHoldRuntimeSlot(subChatId);
  const canAdoptHeldClaudeSlot =
    runtime === 'claude' && mode !== 'plan' && Boolean(flowResourceActivityRelease);
  if (hasHeldClaudeSlot && !canAdoptHeldClaudeSlot) {
    releaseWakeHold(subChatId, 'successor cannot adopt Flow wake runtime slot');
  }
  if (hasHeldClaudeSlot && canAdoptHeldClaudeSlot) {
    return { runtimeSlotRelease: null, flowResourceActivityRelease };
  }
  return { runtimeSlotRelease: await acquireRuntimeSlot(), flowResourceActivityRelease };
}

/**
 * A gated Flow awaits exact provider, cancellation, MCP, and runtime cleanup before releasing its
 * activity. Keyed state is only cleared when this execution still owns the chat key.
 */
export async function settleFlowForegroundResources(params: FlowForegroundCleanup): Promise<void> {
  const errors: unknown[] = [];
  const preserveThrownFailure = (error: unknown): unknown =>
    error === undefined ? new Error('Flow cleanup failed without an error value') : error;
  const run = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(preserveThrownFailure(error));
    }
  };
  const mayCleanKeyedState = (): boolean => {
    const current = params.getActiveController();
    return !current || current === params.executionController;
  };
  // Isolate every duty so one failure cannot skip another.
  await run(() => {
    if (mayCleanKeyedState()) params.clearPendingApprovals();
  });
  await run(() => {
    if (mayCleanKeyedState()) params.deleteAbortSource();
  });
  await run(async () => {
    if (!params.resourcesTransferredToWakeHold) {
      await awaitFlowTaskTeardown(params.executionController);
    }
  });
  await run(async () => {
    const results = await Promise.allSettled(params.providerSettlements);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Provider settlement failed');
  });
  await run(params.finalizeLinkedTaskSignal);
  await run(async () => {
    if (params.resourcesTransferredToWakeHold || !params.session) return;
    await disposeClaudeSessionAndWait(params.session);
  });
  await run(async () => {
    if (!params.resourcesTransferredToWakeHold && params.executionContextId) {
      await params.clearExecutionContext(params.executionContextId);
    }
  });
  await run(async () => {
    if (params.chatId && params.flowContinuationClearId) {
      await params.clearFlowContinuation(params.chatId, params.flowContinuationClearId);
    }
  });
  await run(() => {
    if (params.getActiveController() === params.executionController) {
      params.deleteActiveExecution();
    }
  });
  await run(async () => params.cleanupRuntime?.());
  await run(params.unregisterFlowRunAbort);
  const cleanupError =
    errors.length > 1 ? new AggregateError(errors, 'Flow cleanup failed') : errors[0];
  let visibleError = cleanupError;
  try {
    params.release(cleanupError);
  } catch (releaseError) {
    visibleError =
      cleanupError === undefined
        ? releaseError
        : new AggregateError([cleanupError, releaseError], 'Flow cleanup release failed');
  }
  if (visibleError !== undefined) {
    log.error(`[Socket Executor] Flow cleanup failed for ${params.subChatId}`, visibleError);
    throw visibleError;
  }
}
