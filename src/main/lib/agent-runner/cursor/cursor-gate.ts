import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import stableStringify from 'fast-json-stable-stringify';
import { z } from 'zod';
import { isPathWithinProject } from '../../permissions/path-check';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { CodexApprovalRequest } from '../codex/codex-events';
import {
  editQuestion,
  type JsonValue,
  pathSchema,
  readQuestions,
  readStarts,
} from '../path-questions';
import { CURSOR_HOOK_TOOLS, CURSOR_STREAM_TOOLS, type CursorStreamTool } from './cursor-tools';

/** Frink always answers, and never with ask, which would run the tool. */
export type CursorHookAnswer =
  | { permission: 'allow' }
  | { permission: 'deny'; user_message: string }
  | { continue: true };

type ToolInput = Record<string, JsonValue>;
/** A call's questions, or why it is refused; own names Cursor's own file, allowed quietly. */
type CursorQuestions =
  | { kind: 'ask'; questions: CodexApprovalRequest[]; own?: string }
  | { kind: 'refuse'; reason: string };

type Folders = { cwd: string; home: string; realHome: string };
type GateOptions = Folders & {
  hookVersions: readonly string[];
  checkApproval: CodexApprovalCheck;
  turnOver: AbortSignal;
  onStop: (reason: string) => void;
};

const CANT_CHECK = "Frink can't check this tool yet, so it didn't run.";
const CANT_PATH = "Frink can't check this path, so it didn't run.";
const NOT_CHECKED = "Frink couldn't check this step, so it didn't run.";
const TURN_OVER = "This turn has ended, so Frink didn't run this step.";
const CHANGED = 'Cursor changed how it asks Frink, so Frink stopped it.';
const LINKS_OUT = "This search would follow a link out of its folder, so Frink didn't run it.";
const REFUSE: CursorQuestions = { kind: 'refuse', reason: CANT_CHECK };
const REFUSE_PATH: CursorQuestions = { kind: 'refuse', reason: CANT_PATH };
const ALLOW: CursorHookAnswer = { permission: 'allow' };
const deny = (user_message: string): CursorHookAnswer => ({ permission: 'deny', user_message });

// Cursor turns ~, @ and URL forms into other paths, so the path judged is not the one opened.
const REWRITTEN = /^(?:[~@]|[A-Za-z][A-Za-z0-9+.-]*:)/;
const plainPath = z.string().refine((file) => file.trim() === file && !REWRITTEN.test(file));
const plainPaths = z.union([plainPath, z.array(plainPath)]).optional();
// The command is kept exactly as sent, so the card shows what the shell runs.
const shellSchema = z.object({ command: z.string().regex(/\S/), cwd: z.string().default('') });

const SDK_FOLDERS = ['assets', 'agent-tools'];
const questionKey = (question: CodexApprovalRequest) =>
  stableStringify([question.toolName, question.input]);

/** JSON text as a value, or undefined when it is not JSON or holds a __proto__ key. */
function parseJson(text: string): JsonValue | undefined {
  // A parse drops an own __proto__ key, so a call holding one would be judged without it.
  let dropsKey = false;
  try {
    const value = z.json().safeParse(
      JSON.parse(text, (key: string, item: JsonValue) => {
        dropsKey ||= key === '__proto__';
        return item;
      }),
    );
    return value.success && !dropsKey ? value.data : undefined;
  } catch {
    return undefined;
  }
}

const inputSchema = z.record(z.string(), z.json());
const hookSchema = z.object({
  hook_event_name: z.string(),
  cursor_version: z.string(),
  tool_name: z.string().optional(),
  // Cursor sends some tools' input as JSON text.
  tool_input: z.union([z.string().transform(parseJson).pipe(inputSchema), inputSchema]).optional(),
  tool_use_id: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
});
type HookCall = z.infer<typeof hookSchema>;
const succeeded = z.object({ status: z.literal('success') });
const HOOK_TOOLS = new Map(Object.entries(CURSOR_HOOK_TOOLS));
const STREAM_TOOLS = new Map<string, CursorStreamTool | null>(Object.entries(CURSOR_STREAM_TOOLS));

/** True for a file Cursor keeps under <home>/.cursor/projects/<project>/<assets|agent-tools>. */
function isSdkFile(file: string, home: string): boolean {
  const projects = path.join(home, '.cursor', 'projects');
  const [project, folder, ...rest] = path.relative(projects, file).split(path.sep);
  return (
    project !== '..' && folder !== undefined && SDK_FOLDERS.includes(folder) && rest.length > 0
  );
}

/** True when no folder on the way is a link and the file, if there, is one plain file. */
async function plainFile(file: string, home: string): Promise<boolean> {
  try {
    const stat = await lstat(file).catch(() => undefined);
    if (stat && !(stat.isFile() && stat.nlink === 1)) return false;
    let folder = path.dirname(file);
    while (!(await lstat(folder).catch(() => undefined))) folder = path.dirname(folder);
    const real = path.join(await realpath(home), path.relative(home, folder));
    return (await realpath(folder)) === real;
  } catch {
    return false;
  }
}

// macOS also names each user folder under its data volume, and realpath keeps that spelling.
const DATA_VOLUME = '/System/Volumes/Data';
const fileId = (file: string) => {
  const { dev, ino } = statSync(file);
  return `${dev}:${ino}`;
};

/** The disk identity of each folder holding file, from its nearest existing folder to the root. */
function holders(file: string): string[] {
  let dir = file;
  while (!existsSync(dir)) dir = path.dirname(dir);
  const real = realpathSync.native(dir);
  const ids: string[] = [];
  for (const start of [real, path.join(DATA_VOLUME, real)]) {
    for (let up = start; existsSync(up) && up !== path.dirname(up); up = path.dirname(up)) {
      ids.push(fileId(up));
    }
  }
  return [...ids, fileId('/')];
}

/** True when file is folder or inside it, however either is spelled; an error counts as inside. */
function inside(file: string, folder: string): boolean {
  try {
    if (isPathWithinProject(file, folder)) return true;
    return existsSync(folder) && holders(file).includes(fileId(folder));
  } catch {
    return true;
  }
}

/** The files a file tool names, resolved in the chat's folder, and the questions it asks. */
function fileQuestions(question: 'Edit' | 'Read', input: ToolInput, cwd: string) {
  if (question === 'Read') {
    // A glob call reaches the hook as a Grep for nothing that returns file names only.
    const namesOnly = input.pattern === '' && input.output_mode === 'files_with_matches';
    const files = readStarts(input.file_path, cwd, input.glob)?.map((start) => start.file);
    return { files, questions: readQuestions(input.file_path, cwd, input.glob, namesOnly) };
  }
  const file = pathSchema.safeParse(input.file_path);
  if (!file.success) return { files: undefined, questions: undefined };
  return { files: [path.resolve(cwd, file.data)], questions: [editQuestion(cwd, file.data)] };
}

/** True when a link under root leads outside it, through root if it is a link; Cursor's search follows links. */
async function linksOut(root: string): Promise<boolean> {
  if (!existsSync(root)) return false;
  const found = await promisify(execFile)('/usr/bin/find', ['-H', root, '-type', 'l', '-print0'], {
    maxBuffer: 64 * 1024 * 1024,
  }).then(
    ({ stdout }) => stdout.split('\0').filter(Boolean),
    () => undefined,
  );
  if (!found) return true;
  return found.some((link) => !isPathWithinProject(link, root));
}

/** True when a search could reach past its folders through a link. */
async function searchLeaves(input: ToolInput | undefined, cwd: string): Promise<boolean> {
  for (const { root } of readStarts(input?.file_path, cwd, input?.glob) ?? []) {
    if (await linksOut(root)) return true;
  }
  return false;
}

/** The questions one Cursor hook call asks Frink's gate, or why it is refused. */
function questionsForCursorTool(
  toolName: string,
  input: ToolInput | undefined,
  { cwd, home, realHome }: Folders,
): CursorQuestions {
  const rule = HOOK_TOOLS.get(toolName);
  if (!rule || !input || Object.keys(input).some((key) => !rule.keys.includes(key))) {
    return REFUSE;
  }
  const paths = [input.file_path, input.cwd, input.glob];
  if (!paths.every((value) => plainPaths.safeParse(value).success)) return REFUSE_PATH;
  if (rule.question === 'Bash') {
    const shell = shellSchema.safeParse(input);
    if (!shell.success) return REFUSE;
    const { command, cwd: dir } = shell.data;
    if (dir !== '' && !(path.isAbsolute(dir) && isPathWithinProject(dir, cwd))) return REFUSE_PATH;
    return { kind: 'ask', questions: [{ toolName: 'Bash', input: { command } }] };
  }
  const { files, questions } = fileQuestions(rule.question, input, cwd);
  if (!files || !questions) return REFUSE;
  if (files.length === 1 && isSdkFile(files[0], home)) {
    return { kind: 'ask', questions, own: files[0] };
  }
  // Cursor's private home and the user's own Cursor sign-in are never read or written.
  const kept = [home, path.join(realHome, '.cursor')];
  const touchesKept = (file: string) =>
    kept.some((folder) => inside(file, folder) || inside(folder, file));
  return files.some(touchesKept) ? REFUSE_PATH : { kind: 'ask', questions };
}

/** Decides each Cursor hook call and records its allows, so an unasked run stops the turn. */
export function createCursorGate(opts: GateOptions) {
  const { hookVersions, checkApproval, turnOver, onStop } = opts;
  // Cursor's hook and run name a call by different ids, so allowances match by question.
  const allowed = new Map<string, number>();
  // Shell commands allowed before they run, by hook call id, for Cursor's second shell check.
  const shells = new Map<string, string>();
  let canary = false;
  let stopped = false;

  async function decide(verdict: CursorQuestions): Promise<CursorHookAnswer> {
    if (verdict.kind === 'refuse') return deny(verdict.reason);
    if (verdict.own !== undefined && !(await plainFile(verdict.own, opts.home))) {
      return deny(CANT_PATH);
    }
    for (const question of verdict.own === undefined ? verdict.questions : []) {
      const outcome = await checkApproval(question);
      if (turnOver.aborted) return deny(TURN_OVER);
      if (outcome.allowed === false) return deny(outcome.message);
      if (outcome.allowed === null) return deny(NOT_CHECKED);
    }
    if (turnOver.aborted) return deny(TURN_OVER);
    for (const key of verdict.questions.map(questionKey)) {
      allowed.set(key, (allowed.get(key) ?? 0) + 1);
    }
    return ALLOW;
  }

  async function judge(hook: HookCall): Promise<CursorHookAnswer> {
    if (hook.hook_event_name === 'beforeSubmitPrompt') {
      canary = true;
      return { continue: true };
    }
    const id = hook.tool_use_id;
    if (hook.hook_event_name === 'beforeShellExecution') {
      const input = { command: hook.command ?? null, cwd: hook.cwd ?? '' };
      const verdict = questionsForCursorTool('Shell', input, opts);
      if (verdict.kind === 'ask' && id && shells.get(id) === hook.command) {
        shells.delete(id);
        return ALLOW;
      }
      return decide(verdict);
    }
    if (hook.hook_event_name !== 'preToolUse') return deny(CANT_CHECK);
    const toolName = hook.tool_name ?? '';
    const verdict = questionsForCursorTool(toolName, hook.tool_input, opts);
    if (
      toolName === 'Grep' &&
      verdict.kind === 'ask' &&
      (await searchLeaves(hook.tool_input, opts.cwd))
    ) {
      return deny(LINKS_OUT);
    }
    const answer = await decide(verdict);
    const shell = shellSchema.safeParse(hook.tool_input);
    if (toolName === 'Shell' && id && answer === ALLOW && shell.success) {
      shells.set(id, shell.data.command);
    }
    return answer;
  }

  return {
    /** Answers one hook call from the JSON text Cursor sent the hook. */
    async answer(body: string): Promise<CursorHookAnswer> {
      try {
        const hook = hookSchema.safeParse(parseJson(body));
        if (!hook.success) return deny(CANT_CHECK);
        // One untested version stops the turn, so every later call is denied too.
        stopped ||= !hookVersions.includes(hook.data.cursor_version);
        if (stopped) {
          onStop(CHANGED);
          return deny(CHANGED);
        }
        if (turnOver.aborted) return deny(TURN_OVER);
        return await judge(hook.data);
      } catch (error) {
        log.error('[Cursor] Permission check failed; refusing', error);
        return deny(NOT_CHECKED);
      }
    },
    canarySeen: () => canary,
    /** True when a call that succeeded used up no allowance; a failed call never trips but still
     *  uses up its allowance, so a later unasked run of the same step cannot reuse it. */
    actedUnasked(call: { name: string; args: unknown; result: unknown }): boolean {
      const ran = succeeded.safeParse(call.result).success;
      const tool = STREAM_TOOLS.get(call.name);
      if (tool === null) return false;
      const args = inputSchema.safeParse(call.args);
      if (!tool || !args.success) return ran;
      const input: ToolInput = {};
      for (const [from, to] of Object.entries(tool.keys)) {
        if (Object.hasOwn(args.data, from)) input[to] = args.data[from];
      }
      const verdict = questionsForCursorTool(tool.tool, { ...tool.input, ...input }, opts);
      if (verdict.kind === 'refuse') return ran;
      let unasked = false;
      for (const key of verdict.questions.map(questionKey)) {
        const left = allowed.get(key) ?? 0;
        if (left > 0) allowed.set(key, left - 1);
        else unasked = true;
      }
      return ran && unasked;
    },
  };
}
