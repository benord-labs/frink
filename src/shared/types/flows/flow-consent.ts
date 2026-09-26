/**
 * Shape of the per-flow agent-run consent card, shared main <-> renderer.
 *
 * A flow's NAME is chosen by the agent that authored it, so the name alone is
 * not informed consent. The card also states what the graph will execute and,
 * for a batch, how much work one approval authorises.
 */
export type FlowConsentSummary = {
  nodeCount: number;
  /** Block types in graph order, deduped, for a legible one-line summary. */
  blockTypes: string[];
  /** Block types that run unsandboxed shell — surfaced prominently in the card. */
  unsandboxedBlockTypes: string[];
  /** Set for batch starts: how much work the single approval authorises. */
  batch?: { stageCount: number; pendingRunCount: number };
};

export type FlowConsentPromptData = {
  flowId: string;
  flowName: string;
  summary: FlowConsentSummary;
  /**
   * False under Auto Mode, where the card offers only the standing grant: a
   * one-call approval cannot survive the park-and-retry cycle that follows,
   * so offering it would produce a button that silently does nothing.
   */
  allowOnce: boolean;
};
