import path from 'node:path';
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import log from 'electron-log';
import type { UIMessageChunk } from '../../claude/types';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { CodexApprovalRequest } from '../codex/codex-events';
import { type CommandLedger, shellQuote } from './acp-command-ledger';
import {
  describesStepWithoutKind,
  inputKeys,
  inputText,
  type KnownToolCall,
  namesCommand,
  PATH_TOOL_BY_KIND,
  rememberToolCall,
  toolCallCommand,
  toolCallPaths,
} from './acp-tool-calls';
import { type AcpTurnState, mapToolCall } from './acp-updates';

export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** The questions Frink's permission gate can be asked, by the tool names its rules use. */
type GateQuestion = 'Bash' | 'Read' | 'Edit' | 'WebFetch' | 'WebSearch';

/** How to read one agent's tool calls, for agents that name the tool only in a call's title. */
export type AcpAgentRules = {
  /** The question each tool raises, keyed by the first title of its call. */
  toolQuestions: Readonly<Record<string, GateQuestion>>;
  /** Input keys that never change what runs or where. */
  ignoredInputKeys: readonly string[];
  /** Tools, by first title, that may finish without asking. */
  quietTools: readonly string[];
};

/** The agent's input key each question reads, and the key Frink's rules expect it under. */
const QUESTION_INPUT = {
  Bash: ['command', 'command'],
  Read: ['filepath', 'file_path'],
  Edit: ['filepath', 'file_path'],
  WebFetch: ['url', 'url'],
  WebSearch: ['query', 'query'],
} as const satisfies Record<GateQuestion, readonly [from: string, to: string]>;

/** The question a tool raises, for a tool the rules name; never one inherited from Object. */
export function questionForTool(rules: AcpAgentRules, tool: string | undefined) {
  return tool !== undefined && Object.hasOwn(rules.toolQuestions, tool)
    ? rules.toolQuestions[tool]
    : undefined;
}

type QuestionContext = { rules: AcpAgentRules; cwd: string };

/** A command that runs in another directory is asked about as a move there first. */
function commandQuestion(command: string, toolCall: KnownToolCall, cwd: string) {
  const { workdir } = toolCall;
  const moved = workdir !== undefined && path.resolve(cwd, workdir) !== path.resolve(cwd);
  const asked = moved ? `cd ${shellQuote(workdir)} && ${command}` : command;
  return { toolName: 'Bash', input: { command: asked }, reason: toolCall.title ?? undefined };
}

/** The one question a request of kind other raises, chosen by the tool its call first named. */
function questionsByTool(toolCall: KnownToolCall, { rules, cwd }: QuestionContext) {
  const question = questionForTool(rules, toolCall.tool);
  if (!question) return [];
  const [from, to] = QUESTION_INPUT[question];
  const value = inputText(toolCall, from);
  const ignored = new Set<string>([from, ...rules.ignoredInputKeys]);
  if (!value?.trim()) return [];
  if (inputKeys(toolCall)?.some((key) => !ignored.has(key))) return [];
  if (question === 'Bash') return [commandQuestion(value.trim(), toolCall, cwd)];
  return [{ toolName: question, input: { [to]: value }, reason: toolCall.title ?? undefined }];
}

/** The questions a command or file action raises, judged by the kind the call reports. */
function questionsByKind(toolCall: KnownToolCall, command: string | undefined, cwd: string) {
  const pathTool = toolCall.kind ? PATH_TOOL_BY_KIND.get(toolCall.kind) : undefined;
  // Any other kind is refused even when its input is a command: that tool is not Frink's shell.
  if (toolCall.kind !== 'execute' && !pathTool) return [];
  const paths = pathTool ? toolCallPaths(toolCall) : [];
  // A file action that names no file leaves nothing to ask about.
  if (pathTool && paths.length === 0) return [];
  const reason = toolCall.title ?? undefined;
  const files = paths.map((file_path) => ({
    toolName: pathTool ?? '',
    input: { file_path },
    reason,
  }));
  return command ? [commandQuestion(command, toolCall, cwd), ...files] : files;
}

/**
 * The questions Frink's permission gate is asked for one ACP tool call. Empty when the call cannot
 * be described to the gate, which the caller must treat as a refusal and never as an approval.
 */
function approvalRequestsFor(
  toolCall: KnownToolCall,
  context: QuestionContext,
): CodexApprovalRequest[] {
  if (toolCall.kind === 'other') return questionsByTool(toolCall, context);
  const command = toolCallCommand(toolCall);
  // A command Frink cannot read exactly is refused, not judged on part of what would run.
  if (namesCommand(toolCall) && !command) return [];
  if (toolCall.kind !== 'fetch') return questionsByKind(toolCall, command, context.cwd);
  const url = inputText(toolCall, 'url');
  return url ? [{ toolName: 'WebFetch', input: { url }, reason: toolCall.title ?? undefined }] : [];
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

const questionKey = (request: CodexApprovalRequest) =>
  JSON.stringify([request.toolName, request.input]);

/** Statuses after which a call can run nothing more. */
const CALL_ENDED = new Set(['completed', 'failed']);

async function verdictFor(
  requests: CodexApprovalRequest[],
  checkApproval: CodexApprovalCheck,
  turnOver: AbortSignal,
): Promise<Verdict> {
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

/** What answering a permission request needs from the turn it arrives in. */
type PermissionTurn = QuestionContext & {
  state: AcpTurnState;
  checkApproval: CodexApprovalCheck;
  /** Aborted once the turn can take no more answers. */
  turnOver: AbortSignal;
  ledger?: CommandLedger;
  emit: (chunk: UIMessageChunk) => void;
};

/** Asks the gate the questions the call has not had allowed yet; a command it newly allows is held. */
async function settle(
  toolCall: KnownToolCall,
  questions: CodexApprovalRequest[],
  turn: PermissionTurn,
  isCurrent: () => boolean,
): Promise<Verdict> {
  if (questions.length === 0) return 'unchecked';
  const allowedBefore = turn.state.allowed.get(toolCall.toolCallId);
  const pending = questions.filter((request) => !allowedBefore?.has(questionKey(request)));
  const verdict = await verdictFor(pending, turn.checkApproval, turn.turnOver);
  const command = inputText(toolCall, 'command');
  // A repeat of a request already allowed may not run its command again.
  const asksCommand = pending.some((request) => request.toolName === 'Bash');
  // An allowance never outlives its call or turn, even when the answer comes after either ended.
  const live = () =>
    isCurrent() &&
    !turn.turnOver.aborted &&
    !CALL_ENDED.has(turn.state.toolCalls.get(toolCall.toolCallId)?.status ?? '');
  if (verdict === 'allowed' && asksCommand && command !== undefined && live()) {
    await turn.ledger?.hold(toolCall.toolCallId, command);
    if (!live()) await turn.ledger?.release(toolCall.toolCallId);
  }
  return verdict;
}

/**
 * Answers one ACP permission request from Frink's permission gate. An approval selects the agent's
 * allow-once option and nothing longer-lived, because Frink's own rule store is the memory.
 */
export async function answerPermissionRequest(
  request: RequestPermissionRequest,
  turn: PermissionTurn,
): Promise<RequestPermissionResponse> {
  const { state } = turn;
  const id = request.toolCall.toolCallId;
  const start = state.starts.get(id);
  const isCurrent = () => state.starts.get(id) === start;
  state.asked.add(id);
  // The request joins what earlier updates said: either may hold what the other leaves out.
  mapToolCall(request.toolCall, state, 'request').forEach(turn.emit);
  const toolCall = rememberToolCall(state.toolCalls, request.toolCall, 'request');
  // An earlier report may describe another step: a request that describes one must name its kind.
  const questions = describesStepWithoutKind(request.toolCall)
    ? []
    : approvalRequestsFor(toolCall, turn);
  if (questions.length === 0) {
    log.warn(`[ACP] Refused a ${toolCall.kind ?? 'tool'} call Frink cannot ask its rules about`);
  }
  let verdict: Verdict = 'unchecked';
  try {
    verdict = await settle(toolCall, questions, turn, isCurrent);
  } catch (error) {
    log.error('[ACP] Permission check failed; refusing', error);
  }
  // A new call took the id while the gate was asked: it inherits nothing, and the old one is refused.
  if (!isCurrent()) {
    return turn.turnOver.aborted ? CANCELLED : selectOption(request.options, ['reject_once']);
  }
  if (verdict === 'allowed') {
    state.allowed.set(
      id,
      new Set([...(state.allowed.get(id) ?? []), ...questions.map(questionKey)]),
    );
  } else {
    state.allowed.delete(id);
    void turn.ledger?.release(id);
  }
  // A refusal no rule or person made is shown as Frink's, never as the user's.
  if (verdict === 'unchecked') state.unchecked.add(id);
  else state.unchecked.delete(id);
  if (turn.turnOver.aborted) return CANCELLED;
  const wanted: PermissionOptionKind[] =
    verdict === 'allowed' ? ['allow_once', 'reject_once'] : ['reject_once'];
  return selectOption(request.options, wanted);
}
