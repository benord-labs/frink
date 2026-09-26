/**
 * The resource-level consent gate: may an agent run THIS flow?
 *
 * Split from `flow-tool-dispatch` because the two gates answer different
 * questions — that one rules on the TOOL via the v2 dispatcher, this one on the
 * FLOW — and only this one raises a card, holds a batch against growth, and
 * records a standing grant.
 */
import {
  FLOW_CONSENT_BATCH_CHANGED_MESSAGE,
  FLOW_CONSENT_DENIED_MESSAGE,
  FLOW_CONSENT_EXPIRED_MESSAGE,
  FLOW_CONSENT_PENDING_MESSAGE,
  FLOW_CONSENT_SUPERSEDED_MESSAGE,
  FLOW_CONSENT_UNAVAILABLE_MESSAGE,
  STALE_FLOW_CONTEXT_MESSAGE,
} from './consent-messages';

export { releaseBatchConsent };

import {
  buildFlowConsentSummary,
  type FlowConsentAnswer,
  markBatchAwaitingConsent,
  type RequestFlowConsent,
  releaseBatchConsent,
  requestFlowConsentOnce,
} from './flow-invocation-consent';
import type { FlowConsentStore, FlowGateContext } from './flow-tool-dispatch';

/**
 * Flow tools that EXECUTE a flow, as opposed to editing or reading one. These
 * need per-flow consent on top of the tool-level v2 decision, because the thing
 * being authorised is a resource (which flow runs) not a capability (which tool
 * may be called). `define_stages` / `add_stage_runs` are absent deliberately:
 * they only insert pending rows, and every dispatch is a successor of a stage
 * that `start_batch` started.
 */
const FLOW_EXECUTING_TOOLS = new Set(['frink_flows_run', 'frink_flows_start_batch']);

const GLOBAL_CONSENT_SESSION_KEY = '__global_flow_consent__';

export type FlowInvocationDecision =
  | { allowed: true; invocationConsented: boolean; heldBatchId?: string }
  /** `holdsBatchUntilAnswered` marks the unattended path, whose card outlives this call. */
  | { allowed: false; message: string; holdsBatchUntilAnswered?: boolean };

const ALLOW_WITHOUT_CONSENT: FlowInvocationDecision = {
  allowed: true,
  invocationConsented: false,
};

/**
 * Per-flow consent for a tool that EXECUTES a flow.
 *
 * Runs strictly after `gateFlowWrite`, so it can only ever narrow: an explicit
 * deny rule has already blocked the call before this is reached. When the flow
 * carries no standing `agent_invocable` grant, the user is asked in chat rather
 * than sent to Flow settings.
 *
 * Returns `allowed: true` with no consent when there is nobody to ask (no live
 * chat context, or no consent transport injected) — the handler then applies
 * the terminal `agent_invocable` check itself, so this is never a bypass.
 */
export async function gateFlowInvocation(
  ctx: FlowGateContext | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
  requestConsent: RequestFlowConsent | undefined,
  store: FlowConsentStore | undefined,
  executionId?: string,
  isExecutionCurrent?: () => boolean,
): Promise<FlowInvocationDecision> {
  if (!FLOW_EXECUTING_TOOLS.has(toolName)) return ALLOW_WITHOUT_CONSENT;
  const flowId = typeof args.flowId === 'string' ? args.flowId : undefined;
  if (!flowId || !ctx || !requestConsent || !store) return ALLOW_WITHOUT_CONSENT;

  const ask = await prepareFlowAsk(ctx, store, toolName, flowId, args, executionId);
  if ('decision' in ask) return ask.decision;

  // Hold the batch against growth from the moment we ask. The hold is released
  // by the dispatcher once the approved run has started (or here, if the run
  // never gets that far) — releasing when the card settles would reopen the
  // window, since dispatch re-reads the pending stages after that.
  const { heldBatchId } = ask;
  if (heldBatchId) markBatchAwaitingConsent(heldBatchId);

  const decision = await decideFlowInvocation({
    ...ask,
    ctx,
    store,
    requestConsent,
    flowId,
    toolName,
    args,
    isExecutionCurrent,
  });
  // Who releases the hold depends on how far the call got:
  //  - allowed  -> the dispatcher, once the approved run has actually started.
  //  - pending  -> the detached card itself, when it is finally answered; the card
  //                is still open and still quoting a size, so the batch must
  //                stay frozen even though this call is returning now.
  //  - refused  -> here, since nothing downstream will ever run.
  if (heldBatchId && !decision.allowed && !decision.holdsBatchUntilAnswered) {
    releaseBatchConsent(heldBatchId);
  }
  return decision.allowed ? { ...decision, heldBatchId } : decision;
}

type PreparedAsk = {
  flow: Awaited<ReturnType<FlowConsentStore['getFlow']>>;
  summary: ReturnType<typeof buildFlowConsentSummary>;
  sessionKey: string;
  actionKey: string;
  isUnattendedTurn: boolean;
  batchMagnitude: BatchMagnitude | undefined;
  heldBatchId: string | undefined;
};

/**
 * Read the flow and work out what the card would say — or that no card is owed.
 *
 * Returns a `decision` when the gate settles without asking: the flow already
 * carries a standing grant, cannot run at all, or is a batch whose size we
 * failed to read.
 */
async function prepareFlowAsk(
  ctx: FlowGateContext,
  store: FlowConsentStore,
  toolName: string,
  flowId: string,
  args: Record<string, unknown>,
  executionId: string | undefined,
): Promise<PreparedAsk | { decision: FlowInvocationDecision }> {
  let flow: Awaited<ReturnType<FlowConsentStore['getFlow']>>;
  try {
    flow = await store.getFlow(flowId);
  } catch {
    // A missing flow is the handler's story to tell, with its canonical
    // not-found message; asking about a flow that may not exist is worse.
    return { decision: ALLOW_WITHOUT_CONSENT };
  }
  // Nothing to consent to on a flow that cannot run: the handler refuses it
  // anyway, and asking would let a user grant a standing right off a card for
  // a run that was never going to start.
  if (flow.agent_invocable || !flow.is_enabled) return { decision: ALLOW_WITHOUT_CONSENT };

  const batchMagnitude = await describeBatchMagnitude(store, toolName, flowId, args);
  // A batch card must quote a size and hold the batch at it. If the size cannot
  // be read, both protections are gone — refuse rather than ask for something
  // we cannot describe or bound.
  if (toolName === 'frink_flows_start_batch' && !batchMagnitude) {
    return { decision: { allowed: false, message: FLOW_CONSENT_UNAVAILABLE_MESSAGE } };
  }

  return composeConsentAsk(ctx, toolName, flowId, args, executionId, flow, batchMagnitude);
}

/** Turn an eligible flow into the exact card this action would raise. */
function composeConsentAsk(
  ctx: FlowGateContext,
  toolName: string,
  flowId: string,
  args: Record<string, unknown>,
  executionId: string | undefined,
  flow: Awaited<ReturnType<FlowConsentStore['getFlow']>>,
  batchMagnitude: BatchMagnitude | undefined,
): PreparedAsk {
  const batchId = typeof args.batchId === 'string' ? args.batchId : undefined;
  // Only a Flow-driven Auto turn has nobody to answer; a person's Auto chat waits on the card.
  const isUnattendedTurn = ctx.autoReviewTools === true && ctx.isFlowDrivenTurn === true;
  return {
    flow,
    summary: buildFlowConsentSummary(flow.graph, batchMagnitude),
    // Scoped to the SUB-CHAT, not the turn: an unattended card outlives the turn
    // that raised it, and the agent's parked retry arrives under a new
    // execution. Keying on executionId would stack a duplicate card per retry.
    sessionKey: ctx.subChatId || executionId || GLOBAL_CONSENT_SESSION_KEY,
    // Scoped to the action, not just the flow: the card quotes this action's
    // magnitude, so a grant must not carry over to a differently-sized one. The
    // mode is part of the ask too — an unattended card is detached from its turn and
    // offers no "Allow once", so an interactive call must never inherit one; it
    // would hang on a card its own abort cannot dismiss.
    actionKey: `${toolName} ${flowId} ${batchId ?? ''} ${
      isUnattendedTurn ? 'unattended' : 'interactive'
    }`,
    isUnattendedTurn,
    batchMagnitude,
    // Only a batch can grow under the user while they read the card.
    heldBatchId: batchMagnitude ? batchId : undefined,
  };
}

type BatchMagnitude = { stageCount: number; pendingRunCount: number };

type DecideParams = PreparedAsk & {
  ctx: FlowGateContext;
  store: FlowConsentStore;
  requestConsent: RequestFlowConsent;
  flowId: string;
  toolName: string;
  args: Record<string, unknown>;
  isExecutionCurrent?: () => boolean;
};

async function decideFlowInvocation(params: DecideParams): Promise<FlowInvocationDecision> {
  const { ctx, store, requestConsent, flow, flowId, summary, sessionKey, actionKey } = params;
  if (params.isUnattendedTurn) return raiseDetachedCard(params);

  let answer: FlowConsentAnswer;
  try {
    answer = await requestFlowConsentOnce(sessionKey, actionKey, () =>
      requestConsent({
        chatId: ctx.chatId,
        subChatId: ctx.subChatId,
        flowId,
        flowName: flow.name,
        summary,
        allowOnce: true,
        abortSignal: ctx.abortSignal,
      }),
    );
  } catch {
    // The card could not be delivered or answered (socket drop, transport
    // fault). Refuse this call with a readable message rather than rejecting
    // the tool call — an agent can act on a result, not on a thrown promise.
    return { allowed: false, message: FLOW_CONSENT_UNAVAILABLE_MESSAGE };
  }

  const { decision } = answer;
  if (decision === 'denied') return { allowed: false, message: FLOW_CONSENT_DENIED_MESSAGE };
  if (decision === 'expired') return { allowed: false, message: FLOW_CONSENT_EXPIRED_MESSAGE };
  // "Always allow this Flow" is a statement about the FLOW, not about this
  // run's outcome, so it is recorded on the click. Deferring it until the run
  // succeeded would silently discard the grant whenever the run was then
  // refused — a disabled flow, an invalid graph, or a turn that ended while
  // the card was open.
  if (decision === 'always') await persistStandingFlowGrant(store, flowId);
  return claimApprovedRun(params, answer);
}

/**
 * Raise a card that outlives this call and return immediately.
 *
 * On a Flow-driven Auto turn nobody is watching in-band, so awaiting would park
 * an unattended run on a card for the full permission timeout — the 9.5-minute stall the
 * one-permission-system ruling exists to remove. Only the standing grant is
 * offered: a one-call approval cannot span the agent's parked retry, which
 * arrives under a new execution.
 */
function raiseDetachedCard({
  ctx,
  store,
  requestConsent,
  flow,
  flowId,
  summary,
  sessionKey,
  actionKey,
  heldBatchId,
}: DecideParams): FlowInvocationDecision {
  void requestFlowConsentOnce(sessionKey, actionKey, () =>
    requestConsent({
      chatId: ctx.chatId,
      subChatId: ctx.subChatId,
      flowId,
      flowName: flow.name,
      summary,
      allowOnce: false,
      // Deliberately unlinked from the turn: this card outlives the run
      // that raised it, so a later click still records the grant.
    }),
  )
    .then((answer) =>
      answer.decision === 'always' ? persistStandingFlowGrant(store, flowId) : undefined,
    )
    .catch(() => {})
    // The card is still quoting a size to the user, so the batch stays frozen
    // until they answer it — not merely until this call returns.
    .finally(() => {
      if (heldBatchId) releaseBatchConsent(heldBatchId);
    });
  return { allowed: false, message: FLOW_CONSENT_PENDING_MESSAGE, holdsBatchUntilAnswered: true };
}

/** Last checks between a user's click and the run actually starting. */
async function claimApprovedRun(
  { store, toolName, flowId, args, batchMagnitude, isExecutionCurrent }: DecideParams,
  answer: FlowConsentAnswer,
): Promise<FlowInvocationDecision> {
  // The card may have hung on a long human pause. Re-check liveness BEFORE
  // spending a one-call approval: burning it for a turn that can no longer run
  // would strand the user's click with nothing to show for it.
  if (isExecutionCurrent?.() === false) {
    return { allowed: false, message: STALE_FLOW_CONTEXT_MESSAGE };
  }
  // The batch is held against growth from the moment we asked, so this only
  // catches a change that landed before the hold — but the card quoted a
  // number, so verify it still holds rather than trusting the lock alone.
  if (batchMagnitude) {
    const current = await describeBatchMagnitude(store, toolName, flowId, args);
    if (current && current.pendingRunCount > batchMagnitude.pendingRunCount) {
      return { allowed: false, message: FLOW_CONSENT_BATCH_CHANGED_MESSAGE };
    }
  }
  // A sibling call in this turn may already have spent the single run the user
  // approved. Consuming it twice would turn one click into two executions.
  if (answer.decision === 'once' && !answer.claimOnce()) {
    return { allowed: false, message: FLOW_CONSENT_SUPERSEDED_MESSAGE };
  }
  return { allowed: true, invocationConsented: true };
}

/** Batch consent must quote the work it authorises, not just the flow's name. */
async function describeBatchMagnitude(
  store: FlowConsentStore,
  toolName: string,
  flowId: string,
  args: Record<string, unknown>,
): Promise<BatchMagnitude | undefined> {
  if (toolName !== 'frink_flows_start_batch') return undefined;
  const batchId = typeof args.batchId === 'string' ? args.batchId : undefined;
  if (!batchId) return undefined;
  try {
    const { stages } = await store.listFlowBatchStages(flowId, batchId);
    return {
      stageCount: stages.length,
      pendingRunCount: stages.reduce((total, stage) => total + (stage.run_count ?? 0), 0),
    };
  } catch {
    // Losing the count means losing both the disclosed magnitude AND the
    // growth hold, so the caller refuses rather than asking for a batch it
    // cannot describe.
    return undefined;
  }
}

async function persistStandingFlowGrant(store: FlowConsentStore, flowId: string): Promise<void> {
  try {
    await store.updateFlow(flowId, { agentInvocable: true });
  } catch {
    // The run was authorized and has started; failing to record the standing
    // grant only means the user is asked again next time.
  }
}
