import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionResponse,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import log from 'electron-log';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { CodexApprovalRequest } from '../codex/codex-events';
import { namesCommand, PATH_TOOL_BY_KIND, toolCallCommand, toolCallPaths } from './acp-tool-calls';

export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/**
 * The questions Frink's permission gate is asked for one ACP tool call. Empty when the call cannot
 * be described to the gate, which the caller must treat as a refusal and never as an approval.
 */
export function approvalRequestsFor(toolCall: ToolCallUpdate): CodexApprovalRequest[] {
  const reason = toolCall.title ?? undefined;
  const command = toolCallCommand(toolCall);
  // A command Frink cannot read exactly is refused, not judged on part of what would run.
  if (namesCommand(toolCall) && !command) return [];
  const pathTool = toolCall.kind ? PATH_TOOL_BY_KIND.get(toolCall.kind) : undefined;
  // Any other kind is refused even when its input is a command: that tool is not Frink's shell.
  if (toolCall.kind !== 'execute' && !pathTool) return [];
  const requests: CodexApprovalRequest[] = [];
  if (command) requests.push({ toolName: 'Bash', input: { command }, reason });
  if (pathTool) {
    const paths = toolCallPaths(toolCall);
    // A file action that names no file still reaches the gate, which asks about an empty path.
    for (const file_path of paths.length > 0 ? paths : ['']) {
      requests.push({ toolName: pathTool, input: { file_path }, reason });
    }
  }
  return requests;
}

/** The agent's own option of the first wanted kind it offered, else the cancelled outcome. */
function selectOption(
  options: PermissionOption[],
  wanted: PermissionOptionKind[],
): RequestPermissionResponse {
  for (const kind of wanted) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  return CANCELLED;
}

/** How Frink's gate settled one call: no rule or person decided it when the result is unchecked. */
type Verdict = 'allowed' | 'denied' | 'unchecked';

/** The answer to the agent, and whether a rule or a person decided it. */
export type PermissionAnswer = { response: RequestPermissionResponse; checked: boolean };

async function verdictFor(
  requests: CodexApprovalRequest[],
  checkApproval: CodexApprovalCheck,
  turnOver: AbortSignal,
): Promise<Verdict> {
  if (requests.length === 0) return 'unchecked';
  // One answer covers the whole call, so the first question that is not allowed refuses all of it.
  for (const request of requests) {
    // No card opens for a turn that is over, even when it ended between two questions.
    if (turnOver.aborted) return 'denied';
    const outcome = await checkApproval(request);
    if (outcome.allowed === null) return 'unchecked';
    if (!outcome.allowed) return 'denied';
  }
  return 'allowed';
}

/**
 * Answers one ACP permission request from Frink's permission gate. An approval selects the agent's
 * allow-once option and nothing longer-lived, because Frink's own rule store is the memory.
 */
export async function answerPermissionRequest(
  requests: CodexApprovalRequest[],
  options: PermissionOption[],
  checkApproval: CodexApprovalCheck,
  turnOver: AbortSignal,
): Promise<PermissionAnswer> {
  let verdict: Verdict = 'unchecked';
  try {
    verdict = await verdictFor(requests, checkApproval, turnOver);
  } catch (error) {
    log.error('[ACP] Permission check failed; refusing', error);
  }
  const checked = verdict !== 'unchecked';
  if (turnOver.aborted) return { response: CANCELLED, checked };
  const wanted: PermissionOptionKind[] =
    verdict === 'allowed' ? ['allow_once', 'reject_once'] : ['reject_once'];
  return { response: selectOption(options, wanted), checked };
}
