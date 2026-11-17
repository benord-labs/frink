import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { JsonValue, SessionHooks } from '@github/copilot-sdk';
import log from 'electron-log';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { CodexApprovalRequest } from '../codex/codex-events';
import { editQuestion, pathSchema, readQuestions, textSchema } from '../path-questions';
import { PATCH_TOOL, readPatch } from './copilot-patch';
import type { CopilotToolRule, CopilotTools } from './copilot-tools';

export type PreToolUseHookInput = Parameters<NonNullable<SessionHooks['onPreToolUse']>>[0];
/** Frink always answers, and never with ask or changed arguments. */
export type PreToolUseHookOutput = {
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
};

type CopilotQuestions =
  | { kind: 'quiet' }
  | { kind: 'ask'; questions: CodexApprovalRequest[] }
  | { kind: 'refuse'; reason: string };

const CANT_CHECK = "Frink can't check this tool yet, so it didn't run.";
const NOT_CHECKED = "Frink couldn't check this step, so it didn't run.";
const TURN_OVER = "This turn has ended, so Frink didn't run this step.";
const REFUSE: CopilotQuestions = { kind: 'refuse', reason: CANT_CHECK };

type ToolInput = Record<string, JsonValue>;
/** A tool's input: a patch for the patch tool, keyed values for every other tool. */
type ToolCall = { kind: 'patch'; patch: string } | { kind: 'input'; input: ToolInput };
const toolCallSchema = z.union([
  z.string().transform((patch): ToolCall => ({ kind: 'patch', patch })),
  z.record(z.string(), z.json()).transform((input): ToolCall => ({ kind: 'input', input })),
]);

/** The agent's input key each single-value question reads, and the key Frink's rules expect. */
const QUESTION_INPUT = {
  Bash: ['command', 'command'],
  Edit: ['path', 'file_path'],
  WebFetch: ['url', 'url'],
  WebSearch: ['query', 'query'],
} as const;

const callKey = (toolName: string, args: JsonValue | undefined) =>
  stableStringify([toolName, args]);
const SESSION_ID = /^[\w-]+$/;

const patchFiles = (patch: string) => readPatch(patch)?.map((entry) => entry.file);

function keysAllowed(args: ToolInput, rule: CopilotToolRule): boolean {
  if (rule.required?.some((key) => !Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    if (!rule.keys.includes(key)) return false;
    const values = rule.values && Object.hasOwn(rule.values, key) ? rule.values[key] : undefined;
    return !values || values.some((allowed) => allowed === value);
  });
}

function argQuestions(
  rule: CopilotToolRule & { question: NonNullable<CopilotToolRule['question']> },
  args: ToolInput,
  cwd: string,
): CodexApprovalRequest[] | undefined {
  const { question } = rule;
  if (question === 'Read') {
    const glob = rule.glob ? args[rule.glob] : undefined;
    // A null or empty glob stands for none, as when it is left out.
    const pattern = glob === null || glob === '' ? undefined : glob;
    return readQuestions(args.path ?? args.paths, cwd, pattern, rule.namesOnly);
  }
  const [from, to] = QUESTION_INPUT[question];
  const value = (question === 'Edit' ? pathSchema : textSchema).safeParse(args[from]);
  if (!value.success) return undefined;
  if (question === 'Edit') return [editQuestion(cwd, value.data)];
  return [{ toolName: question, input: { [to]: value.data } }];
}

/** The questions Frink's gate is asked for one Copilot tool call, or why it is refused. */
export function questionsForCopilotTool(
  toolName: string,
  toolArgs: JsonValue | undefined,
  cwd: string,
  tools: CopilotTools,
): CopilotQuestions {
  const rule = Object.hasOwn(tools, toolName) ? tools[toolName] : undefined;
  const call = toolCallSchema.safeParse(toolArgs);
  if (!rule || !call.success) return REFUSE;
  if (call.data.kind === 'patch') {
    const files = toolName === PATCH_TOOL ? patchFiles(call.data.patch) : undefined;
    return files
      ? { kind: 'ask', questions: files.map((file) => editQuestion(cwd, file)) }
      : REFUSE;
  }
  const { input } = call.data;
  if (!keysAllowed(input, rule)) return REFUSE;
  if (!rule.question) return { kind: 'quiet' };
  const questions = argQuestions({ ...rule, question: rule.question }, input, cwd);
  return questions ? { kind: 'ask', questions } : REFUSE;
}

const ALLOW: PreToolUseHookOutput = { permissionDecision: 'allow' };
const deny = (reason: string): PreToolUseHookOutput => ({
  permissionDecision: 'deny',
  permissionDecisionReason: reason,
});

/** How Copilot reports a finished call; code `denied` means a refusal stopped it before it ran. */
type CallEnd = { error?: { code?: string } };

type GateOptions = {
  cwd: string;
  tools: CopilotTools;
  checkApproval: CodexApprovalCheck;
  turnOver: AbortSignal;
  /** Where Copilot keeps the open session's plan, which it may write without a question. */
  plan?: { configDirectory: string; sessionId: () => string | undefined };
};

/** True when an edit names only the open session's plan file, spelled exactly, as a plain file. */
async function editsOwnPlan(toolArgs: JsonValue | undefined, plan: GateOptions['plan']) {
  const sessionId = plan?.sessionId();
  const call = toolCallSchema.safeParse(toolArgs);
  if (!plan || !sessionId || !SESSION_ID.test(sessionId) || !call.success) return false;
  const folder = path.join('session-state', sessionId);
  const file = path.join(plan.configDirectory, folder, 'plan.md');
  const named = call.data.kind === 'patch' ? patchFiles(call.data.patch) : [call.data.input.path];
  if (!named?.every((name) => name === file)) return false;
  try {
    // No link on the way and no second name for the file, so the write lands nowhere else.
    const [real, root, stat] = await Promise.all([
      realpath(path.dirname(file)),
      realpath(plan.configDirectory),
      lstat(file).catch(() => undefined),
    ]);
    return real === path.join(root, folder) && (!stat || (stat.isFile() && stat.nlink === 1));
  } catch {
    return false;
  }
}

/** Frink's answer for one call: refused, quiet, or allowed only when every question is. */
async function judge(
  toolName: string,
  toolArgs: JsonValue | undefined,
  { cwd, tools, checkApproval, turnOver, plan }: GateOptions,
): Promise<PreToolUseHookOutput> {
  const verdict = questionsForCopilotTool(toolName, toolArgs, cwd, tools);
  if (verdict.kind === 'refuse') {
    log.warn(`[Copilot] Refused a ${toolName} call Frink can't check`);
    return deny(verdict.reason);
  }
  if (verdict.kind === 'quiet') return ALLOW;
  if (tools[toolName]?.question === 'Edit' && (await editsOwnPlan(toolArgs, plan))) {
    return turnOver.aborted ? deny(TURN_OVER) : ALLOW;
  }
  for (const question of verdict.questions) {
    const outcome = await checkApproval(question);
    if (turnOver.aborted) return deny(TURN_OVER);
    if (outcome.allowed === false) return deny(outcome.message);
    if (outcome.allowed === null) return deny(NOT_CHECKED);
  }
  return ALLOW;
}

/**
 * Decides every Copilot tool call before it runs, and records what it allowed so a finished call
 * that was never allowed can stop the turn.
 */
export function createCopilotGate(opts: GateOptions) {
  const { cwd, tools, turnOver } = opts;
  // Copilot's hook does not name the call, so allowances are matched by tool name and input.
  const allowed = new Map<string, number>();
  // The key each started call must match, or null for a quiet tool.
  const started = new Map<string, string | null>();

  return {
    async onPreToolUse(hook: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
      if (turnOver.aborted) return deny(TURN_OVER);
      let key: string | undefined;
      let output: PreToolUseHookOutput;
      try {
        const parsed = z.json().safeParse(hook.toolArgs).data;
        // A key the parse drops, such as an own __proto__, was never judged, so the call is refused.
        const toolArgs =
          stableStringify(parsed) === stableStringify(hook.toolArgs) ? parsed : undefined;
        key = callKey(hook.toolName, toolArgs);
        output = await judge(hook.toolName, toolArgs, opts);
      } catch (error) {
        log.error('[Copilot] Permission check failed; refusing', error);
        output = deny(NOT_CHECKED);
      }
      if (key !== undefined && output.permissionDecision === 'allow') {
        allowed.set(key, (allowed.get(key) ?? 0) + 1);
      }
      return output;
    },
    noteExecutionStart(toolCallId: string, toolName: string, args: JsonValue | undefined): void {
      // Judged by name and input, so a refused call that runs anyway still trips the stop.
      const quiet = questionsForCopilotTool(toolName, args, cwd, tools).kind === 'quiet';
      started.set(toolCallId, quiet ? null : callKey(toolName, args));
    },
    /** True when a call ran, whether or not it succeeded, without an allow left to cover it. */
    actedUnasked(toolCallId: string, end: CallEnd): boolean {
      const key = started.get(toolCallId);
      started.delete(toolCallId);
      if (key === null || end.error?.code === 'denied') return false;
      const left = key === undefined ? 0 : (allowed.get(key) ?? 0);
      if (key !== undefined && left > 0) allowed.set(key, left - 1);
      return left === 0;
    },
  };
}
