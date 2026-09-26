/**
 * Per-flow consent for agent-initiated flow execution.
 *
 * `flows.agent_invocable` is the standing grant (the Flow settings toggle).
 * When it is off, an agent run raises a consent card in the chat instead of
 * dead-ending, so the user can approve one run or turn the standing grant on
 * without leaving the conversation.
 *
 * This module holds NO grant state. A one-call approval travels back to the
 * handler as an argument, so it cannot outlive the call or leak across turns.
 * The only state here is an in-flight promise map that collapses concurrent
 * requests for the same flow onto a single card; entries delete themselves when
 * the card settles.
 */
import { isCustomNodeBlockType } from '../../../../../shared/lib/block-registry';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowConsentSummary } from '../../../../../shared/types/flows/flow-consent';
import { type McpToolResult, toolResult } from '../../tool-result';

export type { FlowConsentSummary };

/**
 * Block types that end up running code on the user's machine with no sandbox.
 *
 * `agent` is included deliberately: it runs a coding agent with tool access, so
 * from the user's side it is every bit as capable as a shell block. A flow of
 * trigger -> agent -> agent would otherwise show a consent card with no warning
 * at all, which is exactly the disclosure the card exists to make.
 */
const UNSANDBOXED_BLOCK_TYPES = new Set(['run_command', 'start_task', 'agent']);

export type FlowConsentRequest = {
  chatId: string;
  subChatId: string;
  flowId: string;
  flowName: string;
  summary: FlowConsentSummary;
  /**
   * False under Auto Mode. A one-call grant cannot survive Auto: the agent
   * parks, the turn ends, and the retry arrives under a new execution — so the
   * card offers only the standing grant and Deny, never a token that would
   * always miss.
   */
  allowOnce: boolean;
  /**
   * The turn whose abort dismisses the card. Omitted for an Auto-mode card,
   * which must survive its turn so a later click still records the grant —
   * omitting is what DETACHES it, and the transport treats that explicitly
   * rather than falling back to the live execution.
   */
  abortSignal?: AbortSignal;
};

/**
 * `expired` is deliberately distinct from `denied`: nobody said no, the card
 * timed out unseen. The agent is told so it can report a stall rather than a
 * refusal the user never made.
 *
 * `superseded` is never a user's answer — it is what a concurrent caller gets
 * when another already claimed the single run a one-call approval covers.
 */
export type FlowConsentDecision = 'once' | 'always' | 'denied' | 'expired' | 'superseded';

/** Injected by the dynamic-chat server so this module never imports the executor. */
export type RequestFlowConsent = (request: FlowConsentRequest) => Promise<FlowConsentDecision>;

/**
 * Read a permission-card answer as a consent decision.
 *
 * `timedOut` is checked FIRST and deliberately: the transport sets it for
 * system-driven settles (timeout, pane close, abort) alongside `approved:
 * false`, so reading approval first would report every unanswered card as a
 * refusal the user never made.
 */
export function readFlowConsentDecision(response: {
  approved: boolean;
  timedOut?: boolean;
  flowGrant?: boolean;
}): FlowConsentDecision {
  if (response.timedOut) return 'expired';
  if (!response.approved) return 'denied';
  return response.flowGrant ? 'always' : 'once';
}

export function buildFlowConsentSummary(
  graph: FlowGraph | null,
  batch?: { stageCount: number; pendingRunCount: number },
): FlowConsentSummary {
  const nodes = graph?.nodes ?? [];
  const blockTypes: string[] = [];
  const unsandboxed: string[] = [];
  for (const node of nodes) {
    const blockType = node.blockType;
    // A hand-edited or older graph can carry a node with no blockType; listing
    // it would render a literal "undefined" on the consent card.
    if (typeof blockType !== 'string' || blockType.length === 0) continue;
    if (!blockTypes.includes(blockType)) blockTypes.push(blockType);
    // A custom node is agent-authored JS run through Frink's managed Node —
    // same informed-consent concern as a first-party shell block.
    const isUnsandboxed =
      UNSANDBOXED_BLOCK_TYPES.has(blockType) || isCustomNodeBlockType(blockType);
    if (isUnsandboxed && !unsandboxed.includes(blockType)) unsandboxed.push(blockType);
  }
  return {
    nodeCount: nodes.length,
    blockTypes,
    unsandboxedBlockTypes: unsandboxed,
    ...(batch ? { batch } : {}),
  };
}

/**
 * The card's answer plus the right to spend it.
 *
 * `claimOnce` is deliberately NOT called when the card resolves: a caller must
 * claim only once it is certain it will actually run, or a superseded turn
 * would burn the single approval and never dispatch it.
 */
export type FlowConsentAnswer = {
  decision: FlowConsentDecision;
  /** True for the first caller to spend a one-call grant, false thereafter. */
  claimOnce: () => boolean;
};

type CardEntry = { card: Promise<FlowConsentDecision>; onceClaimed: boolean };

const inFlight = new Map<string, CardEntry>();

/**
 * Batches with a consent card currently open.
 *
 * The card quotes the batch's size, and dispatch re-reads the stages fresh, so
 * growing a batch while its approval is being decided would start more work
 * than the user agreed to. Rechecking the size after the click narrows that
 * window but cannot close it; refusing the growth outright does.
 */
const batchesAwaitingConsent = new Map<string, number>();

export function isBatchAwaitingConsent(batchId: string): boolean {
  return (batchesAwaitingConsent.get(batchId) ?? 0) > 0;
}

/**
 * Hold a batch against growth. Released only once the run it was approved for
 * has actually dispatched — releasing when the CARD settles would reopen the
 * window, because dispatch re-reads the pending stages after that point.
 */
export function markBatchAwaitingConsent(batchId: string): void {
  batchesAwaitingConsent.set(batchId, (batchesAwaitingConsent.get(batchId) ?? 0) + 1);
}

export function releaseBatchConsent(batchId: string): void {
  // Counted, not a flag: concurrent callers share one card, and a caller that
  // loses the one-call claim must not drop the hold while the winner is still
  // dispatching — dispatch re-reads the pending stages.
  const held = (batchesAwaitingConsent.get(batchId) ?? 0) - 1;
  if (held > 0) batchesAwaitingConsent.set(batchId, held);
  else batchesAwaitingConsent.delete(batchId);
}

/**
 * Collapse concurrent consent requests for one ACTION onto one card.
 *
 * An assistant turn can issue parallel tool calls; without this each would
 * stack an identical card on the user's prompt queue. The key must describe
 * what the card says, not just which flow it names — a single run and a
 * 200-run batch are different asks, so they get different cards. Keyed per
 * execution too, so two chats asking about the same flow decide separately.
 *
 * Sharing the card must not share a one-call grant: "Allow once" authorises a
 * single run, so exactly one caller receives `once` and the rest are told the
 * approval was already spent. A standing grant and a refusal apply to everyone
 * and are handed out unchanged.
 */
export function requestFlowConsentOnce(
  executionKey: string,
  actionKey: string,
  request: () => Promise<FlowConsentDecision>,
): Promise<FlowConsentAnswer> {
  const key = `${executionKey} ${actionKey}`;
  const entry = inFlight.get(key) ?? createCardEntry(key, request);
  return entry.card.then((decision) => ({
    decision,
    claimOnce: () => {
      if (entry.onceClaimed) return false;
      entry.onceClaimed = true;
      return true;
    },
  }));
}

function createCardEntry(key: string, request: () => Promise<FlowConsentDecision>): CardEntry {
  const entry: CardEntry = {
    card: request().finally(() => inFlight.delete(key)),
    onceClaimed: false,
  };
  inFlight.set(key, entry);
  return entry;
}

/**
 * A batch may not grow while the user is being asked to approve running it —
 * the card quotes its size, and dispatch re-reads the stages fresh. Refusing
 * the growth closes that window; re-checking the size after the click only
 * narrows it.
 */
export function refuseIfAwaitingConsent(batchId: string): McpToolResult | null {
  if (!isBatchAwaitingConsent(batchId)) return null;
  return toolResult(
    'This batch cannot grow right now: the user is being asked to approve running it, and the request states its current size. Wait for their answer, then stage any further work in a new batch.',
    true,
  );
}
