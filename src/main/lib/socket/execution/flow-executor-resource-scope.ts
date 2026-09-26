import { disposeCodexAppServerSessionAndWait } from '../../agent-runner/codex/app-server-registry';
import type { FlowResourceActivityRelease } from '../../flows/admission/activity';
import type { PendingContinuationResume } from '../../flows/admission/terminal-resume/continuation';
import {
  endSession as endClaudeSession,
  getSession as getClaudeSession,
} from '../claude-session-registry';
import { hasWakeHold, type WakeHold } from '../claude-wake-hold';
import type { AgentRuntime } from '../runtime-gate';
import {
  createExecutionSettlementBarrier,
  type ExecutionSettlementBarrier,
} from './execution-settlement-barrier';
import {
  acquireExecutorRuntimeSlot,
  type FlowForegroundCleanup,
  type FlowProviderExecutionInput,
  registerFlowProviderExecution,
  settleFlowForegroundResources,
} from './flow-resource-cleanup';

type FlowExecutorSettlement = Omit<
  FlowForegroundCleanup,
  'providerSettlements' | 'cleanupRuntime' | 'unregisterFlowRunAbort' | 'release'
> & {
  /** The execute left its session idle for the registry, so no wake hold on the chat is its own. */
  sessionRetained?: boolean;
};

type FlowWakeResourceTransfer = Pick<
  WakeHold,
  'releaseFlowResourceActivity' | 'releaseRuntimeSlot' | 'unregisterFlowRunAbort'
> & { executionSettlement: ExecutionSettlementBarrier };

function clearLegacyKeyedState(params: FlowExecutorSettlement): void {
  const mayCleanKeyedState = (): boolean => {
    const current = params.getActiveController();
    return !current || current === params.executionController;
  };
  if (mayCleanKeyedState()) params.clearPendingApprovals();
  if (mayCleanKeyedState()) params.deleteAbortSource();
}

function clearLegacyActiveExecution(params: FlowExecutorSettlement): void {
  if (params.getActiveController() === params.executionController) {
    params.deleteActiveExecution();
  }
}

/** Own the Flow-only resource state added around one executor invocation. */
export class FlowExecutorResourceScope {
  private activityRelease: FlowResourceActivityRelease | null = null;
  private runtimeSlotRelease: (() => void) | null = null;
  private rebindFlowRunAbort: ((controller: AbortController) => void) | null = null;
  private unregisterFlowRunAbort: (() => void) | null = null;
  private prepareAndValidateFlowExecution:
    | ((prepareForExecution: () => Promise<void>) => Promise<void>)
    | null = null;
  // Survives clear()/settle on purpose: the executor reads it AFTER settling the turn.
  private pendingContinuationResumeTaker: (() => PendingContinuationResume | null) | null = null;
  private readonly providerSettlements: Promise<void>[] = [];
  private readonly executionSettlement = createExecutionSettlementBarrier();
  private wakeHoldArmed = false;

  get admitted(): boolean {
    return this.activityRelease !== null;
  }

  get hasArmedWakeHold(): boolean {
    return this.wakeHoldArmed;
  }

  readonly waitUntilSettled = (): Promise<void> => this.executionSettlement.wait();

  readonly onProcessSettled = (settlement: Promise<void>): void => {
    void settlement.catch(() => {});
    this.providerSettlements.push(settlement);
  };

  assertLive(signal: AbortSignal, provider: string): void {
    if (signal.aborted) throw new Error(`Execution cancelled before ${provider} launch`);
  }

  async admit(
    provenance: FlowProviderExecutionInput['provenance'],
    expectedFlowTaskId: string | null,
    controller: AbortController,
    chatId?: string,
  ): Promise<void> {
    const registration = await registerFlowProviderExecution({
      provenance,
      expectedFlowTaskId: expectedFlowTaskId ?? undefined,
      controller,
      chatId,
    });
    if (!registration) return;
    this.activityRelease = registration.release;
    this.rebindFlowRunAbort = registration.rebindAbort;
    this.unregisterFlowRunAbort = registration.unregisterAbort;
    this.prepareAndValidateFlowExecution = registration.prepareAndValidate;
    this.pendingContinuationResumeTaker = registration.takePendingContinuationResume;
  }

  /** The continuation re-admission a FLOW_RUN_RESUMING decline recorded — read after settle. */
  takePendingContinuationResume(): PendingContinuationResume | null {
    return this.pendingContinuationResumeTaker?.() ?? null;
  }

  async prepareProviderExecution(prepareForExecution: () => Promise<void>): Promise<void> {
    if (!this.prepareAndValidateFlowExecution) return prepareForExecution();
    await this.prepareAndValidateFlowExecution(prepareForExecution);
  }

  async acquireRuntimeSlot(
    runtime: AgentRuntime,
    mode: string,
    subChatId: string,
    acquire: () => Promise<() => void>,
  ): Promise<void> {
    const resources = await acquireExecutorRuntimeSlot(
      runtime,
      mode,
      subChatId,
      acquire,
      this.activityRelease,
    );
    this.runtimeSlotRelease = resources.runtimeSlotRelease;
    this.activityRelease = resources.flowResourceActivityRelease;
  }

  rebindAbort(controller: AbortController): void {
    this.rebindFlowRunAbort?.(controller);
  }

  adoptWakeHoldRuntimeSlot(hold: WakeHold): void {
    const inherited = hold.releaseRuntimeSlot;
    if (!inherited) return;
    hold.releaseRuntimeSlot = undefined;
    this.runtimeSlotRelease?.();
    this.runtimeSlotRelease = inherited;
  }

  async ensureRuntimeSlot(acquire: () => Promise<() => void>): Promise<void> {
    this.runtimeSlotRelease ??= await acquire();
  }

  armWakeHold<T>(arm: (resources: FlowWakeResourceTransfer) => T): T {
    const transfersFlowResources = this.admitted;
    const hold = arm({
      releaseFlowResourceActivity: this.activityRelease ?? undefined,
      releaseRuntimeSlot: transfersFlowResources
        ? (this.runtimeSlotRelease ?? undefined)
        : undefined,
      unregisterFlowRunAbort: this.unregisterFlowRunAbort ?? undefined,
      executionSettlement: this.executionSettlement,
    });
    if (transfersFlowResources) this.clear();
    this.wakeHoldArmed = true;
    return hold;
  }

  bindCodex(
    controller: AbortController,
    projectPath: string,
    credentialId: string,
    subChatId: string,
  ): () => void {
    const dispose = () => {
      this.onProcessSettled(
        disposeCodexAppServerSessionAndWait(projectPath, credentialId, subChatId),
      );
    };
    controller.signal.addEventListener('abort', dispose, { once: true });
    if (controller.signal.aborted) dispose();
    return () => controller.signal.removeEventListener('abort', dispose);
  }

  async settle(params: FlowExecutorSettlement): Promise<void> {
    try {
      if (this.activityRelease) {
        await this.settleAdmitted(params, this.activityRelease);
      } else {
        await this.settleLegacy(params);
      }
      this.executionSettlement.finish();
    } catch (error) {
      this.executionSettlement.finish(error);
      throw error;
    }
  }

  private async settleAdmitted(
    params: FlowExecutorSettlement,
    release: FlowResourceActivityRelease,
  ): Promise<void> {
    await settleFlowForegroundResources({
      ...params,
      providerSettlements: this.providerSettlements,
      cleanupRuntime: this.runtimeSlotRelease,
      unregisterFlowRunAbort: this.unregisterFlowRunAbort ?? (() => {}),
      release,
    });
    this.clear();
  }

  private async settleLegacy(params: FlowExecutorSettlement): Promise<void> {
    clearLegacyKeyedState(params);
    await params.finalizeLinkedTaskSignal();
    if (params.sessionRetained || !hasWakeHold(params.subChatId, params.session ?? undefined)) {
      if (params.session && getClaudeSession(params.subChatId) === params.session) {
        endClaudeSession(params.subChatId);
      }
      if (params.executionContextId) {
        await params.clearExecutionContext(params.executionContextId);
      }
    }
    if (params.chatId && params.flowContinuationClearId) {
      await params.clearFlowContinuation(params.chatId, params.flowContinuationClearId);
    }
    clearLegacyActiveExecution(params);
    this.runtimeSlotRelease?.();
    this.runtimeSlotRelease = null;
  }

  private clear(): void {
    this.activityRelease = null;
    this.runtimeSlotRelease = null;
    this.rebindFlowRunAbort = null;
    this.unregisterFlowRunAbort = null;
    this.prepareAndValidateFlowExecution = null;
  }
}
