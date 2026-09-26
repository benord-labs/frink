/**
 * Wire payload for 'socket:subagent-task-changed' — per-task liveness for background subagents,
 * keyed by the launching tool call so the renderer's Task/Agent card can flip its label. Fires on
 * foreground turns too (the card must flip at LAUNCH, mid-turn), which is why this is not part of
 * the burst-refreshed WakeHoldState. Lives under wake-hold/ because src/shared/types' root is at
 * its grandfathered fan-out ceiling.
 */
export type SubagentTaskChangedPayload = {
  subChatId: string;
  toolCallId: string;
  running: boolean;
};
