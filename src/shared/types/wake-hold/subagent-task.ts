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

/** One live background task as the CLI's `background_tasks_changed` level signal names it. `type` is
 * the CLI's raw discriminant (e.g. `local_bash`), not the Stop hook's friendly label. */
export type BackgroundRosterTask = {
  id: string;
  type: string;
  description: string;
  /** Not activity (the SDK's own flag): kept for membership, never shown as work on its own. */
  ambient: boolean;
};

/** 'socket:background-tasks-changed': a sub-chat's live background tasks in every phase, display-only
 * (the Stop hook alone ends a wait). `tasks: null` means unknown. */
export type BackgroundRosterPayload = {
  subChatId: string;
  tasks: BackgroundRosterTask[] | null;
};
