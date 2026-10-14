import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { JsonValue, SessionHooks } from '@github/copilot-sdk';
import log from 'electron-log';
import picomatch from 'picomatch';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import { isPathWithinProject } from '../../permissions/path-check';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { CodexApprovalRequest } from '../codex/codex-events';
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
const PATCH_TOOL = 'apply_patch';

type ToolInput = Record<string, JsonValue>;
/** A tool's input: a patch for the patch tool, keyed values for every other tool. */
type ToolCall = { kind: 'patch'; patch: string } | { kind: 'input'; input: ToolInput };
const toolCallSchema = z.union([
  z.string().transform((patch): ToolCall => ({ kind: 'patch', patch })),
  z.record(z.string(), z.json()).transform((input): ToolCall => ({ kind: 'input', input })),
]);
const textSchema = z.string().trim().min(1);
// Copilot reads a leading ~ as a folder name, not home, so such a path is refused.
const pathSchema = textSchema.refine((file) => !file.startsWith('~'));
const pathsSchema = z.union([pathSchema, z.array(pathSchema)]).optional();

/** The agent's input key each single-value question reads, and the key Frink's rules expect. */
const QUESTION_INPUT = {
  Bash: ['command', 'command'],
  Edit: ['path', 'file_path'],
  WebFetch: ['url', 'url'],
  WebSearch: ['query', 'query'],
} as const;

const PATCH_HEADER =
  /^\*\*\* (?:Begin Patch|End Patch|End of File|(?:(?:Add|Update|Delete) File|Move to): (?!~)(\S.*))$/;
const GLOB_CHARS = /[*?[\]{}()!]/;
// A group holding a / or ~ can name any folder, wherever it sits.
const GROUP_LEAVES = /[{(][^})]*[/~]/;
// A segment that can stand for .., however it is spelled, steps out of the folder before it.
const stepsUp = (segment: string) =>
  segment.includes('..') || picomatch.isMatch('..', segment, { dot: true });

const editQuestion = (cwd: string, file: string): CodexApprovalRequest => ({
  toolName: 'Edit',
  input: { file_path: path.resolve(cwd, file) },
});
const callKey = (toolName: string, args: JsonValue | undefined) =>
  stableStringify([toolName, args]);
const SESSION_ID = /^[\w-]+$/;

/** Every file a patch names, or nothing when any header is one Frink cannot read. */
function patchFiles(patch: string): string[] | undefined {
  // Split where the patch tool breaks lines, a lone \r included; trimmed, as it trims headers.
  const lines = patch.split(/\r\n?|\n/).map((line) => line.trim());
  if (lines[0] !== '*** Begin Patch') return undefined;
  const files: string[] = [];
  for (const line of lines.filter((candidate) => candidate.startsWith('***'))) {
    const header = PATCH_HEADER.exec(line);
    if (!header) return undefined;
    if (header[1]) files.push(header[1]);
  }
  return files.length > 0 ? files : undefined;
}

function keysAllowed(args: ToolInput, rule: CopilotToolRule): boolean {
  if (rule.required?.some((key) => !Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    if (!rule.keys.includes(key)) return false;
    const values = rule.values && Object.hasOwn(rule.values, key) ? rule.values[key] : undefined;
    return !values || values.some((allowed) => allowed === value);
  });
}

/** The folder a glob starts from: the segments before its first wildcard. */
function globRoot(pattern: JsonValue | undefined): string | undefined {
  if (pattern === undefined) return '.';
  const parsed = pathSchema.safeParse(pattern);
  // A backslash is an escape to one glob reader and a folder break to another, so it is refused.
  if (!parsed.success || GROUP_LEAVES.test(parsed.data) || parsed.data.includes('\\'))
    return undefined;
  const segments = parsed.data.split('/');
  const wild = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (wild !== -1 && segments.slice(wild).some(stepsUp)) return undefined;
  const root = segments.slice(0, wild === -1 ? undefined : wild).join('/');
  return root || (parsed.data.startsWith('/') ? '/' : '.');
}

/** Reads ask only about folders and files outside the chat's folder; no path reads the folder. */
function readQuestions(
  paths: JsonValue | undefined,
  cwd: string,
  pattern?: JsonValue,
): CodexApprovalRequest[] | undefined {
  const parsed = pathsSchema.safeParse(paths);
  const start = globRoot(pattern);
  if (!parsed.success || start === undefined) return undefined;
  const roots = [parsed.data ?? []].flat();
  return (roots.length > 0 ? roots : [cwd])
    .map((file) => path.resolve(cwd, file, start))
    .filter((file) => !isPathWithinProject(file, cwd))
    .map((file) => ({ toolName: 'Read', input: { file_path: file } }));
}

function argQuestions(
  rule: CopilotToolRule & { question: NonNullable<CopilotToolRule['question']> },
  args: ToolInput,
  cwd: string,
): CodexApprovalRequest[] | undefined {
  const { question } = rule;
  if (question === 'Read') {
    return readQuestions(args.path ?? args.paths, cwd, rule.glob ? args[rule.glob] : undefined);
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
