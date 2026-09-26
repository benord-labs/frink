/**
 * Display-only tracker for background subagent liveness, fed by the SDK's task lifecycle frames.
 *
 * An async Agent launch resolves its tool part immediately, so the renderer card reads "Completed
 * Subagent" while the task runs; `task_started`/`task_notification` carry the `tool_use_id` that
 * correlates a task to its card (optional in the SDK contract, populated by the CLI for Task-tool
 * agents). This lane never feeds the stand-down decision — the Stop hook's background_tasks
 * snapshot remains the authority (docs/decisions/unattended-wake-budget.md).
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SubagentTaskChangedPayload } from '../../../../shared/types/wake-hold/subagent-task';
import { captureMainException } from '../../sentry/init';

/** Per chat: task_id → tool_use_id. Keyed on the REQUIRED field so a terminal frame that omits
 * the optional tool_use_id can still retire its entry instead of stranding a spinning card. */
const runningByChat = new Map<string, Map<string, string>>();

let publish: ((payload: SubagentTaskChangedPayload) => void) | null = null;

/** Injected at boot (src/main/lib/socket/index.ts) so this module stays IO-free and test-spyable. */
export function setSubagentTaskPublisher(
  fn: ((payload: SubagentTaskChangedPayload) => void) | null,
): void {
  publish = fn;
}

type TaskFrame = {
  type?: string;
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  subagent_type?: string;
  task_type?: string;
  skip_transcript?: boolean;
};

/** Only agent-shaped and workflow tasks address a tool card (Task/Agent, Workflow); shells, crons
 * and housekeeping tasks have no card to drive and would be pure broadcast noise. */
function isCardTaskStart(frame: TaskFrame): boolean {
  if (frame.skip_transcript) return false;
  const taskType = String(frame.task_type ?? '');
  return (
    Boolean(frame.subagent_type) || taskType.endsWith('agent') || taskType === 'local_workflow'
  );
}

/**
 * Observe one SDK frame. TOTAL by design — this runs inside the registry's frame chokepoint,
 * where a throw is indistinguishable from the SDK stream dying: the wake pump would finish as
 * 'stream-ended' and dispose a live held session over a cosmetic status signal.
 */
export function noteSubagentTaskFrame(subChatId: string, message: SDKMessage): void {
  if ((message as TaskFrame).type !== 'system') return;
  try {
    const frame = message as TaskFrame;
    if (frame.subtype === 'task_started') {
      if (!frame.task_id || !frame.tool_use_id || !isCardTaskStart(frame)) return;
      const chat = runningByChat.get(subChatId) ?? new Map<string, string>();
      if (chat.has(frame.task_id)) return;
      chat.set(frame.task_id, frame.tool_use_id);
      runningByChat.set(subChatId, chat);
      publish?.({ subChatId, toolCallId: frame.tool_use_id, running: true });
      return;
    }
    if (frame.subtype !== 'task_notification' || !frame.task_id) return;
    const chat = runningByChat.get(subChatId);
    const toolCallId = chat?.get(frame.task_id);
    if (!chat || toolCallId === undefined) return;
    chat.delete(frame.task_id);
    if (chat.size === 0) runningByChat.delete(subChatId);
    publish?.({ subChatId, toolCallId, running: false });
  } catch (error) {
    captureMainException(error, { surface: 'subagent-task-status', stage: 'note-frame' });
  }
}

/** Retract every tracked id for a chat — called from BOTH session-detach seams (endSession and
 * unregisterSessionIfOwned). A silent map drop never crosses IPC, which would strand spinners. */
export function clearSubagentTasks(subChatId: string): void {
  const chat = runningByChat.get(subChatId);
  if (!chat) return;
  runningByChat.delete(subChatId);
  for (const toolCallId of chat.values()) {
    // Caught per id: one failed publish must not strand the REMAINING cards as running.
    try {
      publish?.({ subChatId, toolCallId, running: false });
    } catch (error) {
      captureMainException(error, { surface: 'subagent-task-status', stage: 'retract' });
    }
  }
}

export function __resetSubagentTaskStatusForTest(): void {
  runningByChat.clear();
  publish = null;
}
