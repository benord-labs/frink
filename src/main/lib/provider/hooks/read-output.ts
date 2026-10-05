import { stripVTControlCharacters } from 'node:util';
import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isPlainObject } from '../../../../shared/lib/case-converter';
import { HOOK_EVENT_RULES, HOOK_OUTPUT, HOOK_OUTPUT_FIELDS, type HookEventRule } from './events';
import type { runHookCommand } from './run-command';

type HookCommandOutcome = Awaited<ReturnType<typeof runHookCommand>>;
type CappedText = 'context' | 'systemMessage' | 'additionalContext' | 'initialUserMessage';

/** What Claude makes of one finished hook. It reports what the hook said and decides nothing. */
export type HookReading = Pick<
  SyncHookJSONOutput,
  'continue' | 'stopReason' | 'suppressOutput' | 'systemMessage' | 'hookSpecificOutput'
> & {
  /**
   * Exit code 2 or a blocking decision; what a block does is the event's `exit2` rule. It wins
   * over any decision in `hookSpecificOutput`. Like `error`, it is not capped.
   */
  block?: { reason: string };
  /** Body of the "hook error" notice Claude shows; the action goes ahead. */
  error?: string;
  /** Plain stdout that the event adds to Claude's context. */
  context?: string;
  /** The hook answered `{"async": true}`: it runs on in the background and decides nothing. */
  async?: Omit<AsyncHookJSONOutput, 'async'>;
  /** Texts over the cap, given whole: Claude saves each to a file and passes on a preview. */
  overCap?: CappedText[];
};

type Parsed = { value?: unknown; message?: string };
type Stdout =
  | { text: string }
  | { async: NonNullable<HookReading['async']> }
  | { error: string }
  | { reading: HookReading };

const TEXT_CAP = 10_000;
const CAPPED: CappedText[] = [
  'context',
  'systemMessage',
  'additionalContext',
  'initialUserMessage',
];
const NO_STDERR = 'No stderr output';
/** A notice lists this many schema issues and counts the rest, so its length stays bounded. */
const SHOWN_ISSUES = 5;
const LEGACY_DECISION = { approve: 'allow', block: 'deny' } satisfies Record<
  NonNullable<SyncHookJSONOutput['decision']>,
  'allow' | 'deny'
>;

/** Claude backgrounds a hook on `async` alone and does not hold the timeout to a schema. */
const ASYNC_ANSWER = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional().catch(undefined),
});

function parseJson(text: string): Parsed {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}

function setsOutputField({ value }: Parsed): boolean {
  return (
    isPlainObject(value) && Object.keys(value).some((key) => Object.hasOwn(HOOK_OUTPUT_FIELDS, key))
  );
}

/** Several lines that each parse alone are plain text, unless one of them sets an output field. */
function isJsonLines(text: string): boolean {
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim()) {
      const parsed = parseJson(line);
      if (parsed.message !== undefined || setsOutputField(parsed)) return false;
      lines += 1;
    }
  }
  return lines > 1;
}

function overCap(texts: Partial<Record<CappedText, string>>): Pick<HookReading, 'overCap'> {
  const names = CAPPED.filter((name) => (texts[name]?.length ?? 0) > TEXT_CAP);
  return names.length > 0 ? { overCap: names } : {};
}

/** A hook that did not finish cleanly blocks where the event says so; otherwise it is a notice. */
function failed(rule: HookEventRule, kind: 'timeout' | 'failure', text: string): HookReading {
  if (rule.alsoBlocksOn === kind || rule.alsoBlocksOn === 'failure') {
    return { block: { reason: text } };
  }
  return rule.exit2 === 'ignored' ? {} : { error: text };
}

/** PreToolUse still takes the deprecated top-level decision: approve is allow, block is deny. */
function specificOutput(
  event: HookEvent,
  output: SyncHookJSONOutput,
): HookReading['hookSpecificOutput'] {
  const given = output.hookSpecificOutput;
  const own = given?.hookEventName === 'PreToolUse' ? given : undefined;
  if (event !== 'PreToolUse' || !output.decision || own?.permissionDecision) return given;
  return {
    ...own,
    hookEventName: event,
    permissionDecision: LEGACY_DECISION[output.decision],
    permissionDecisionReason: own?.permissionDecisionReason ?? output.reason,
  };
}

function readJson(event: HookEvent, rule: HookEventRule, output: SyncHookJSONOutput): HookReading {
  const specific = specificOutput(event, output);
  const permission = specific && 'permissionDecision' in specific ? specific : undefined;
  const denied = permission?.permissionDecision === 'deny';
  const blocked = denied || (rule.decision && output.decision === 'block');
  const reason =
    (denied && permission.permissionDecisionReason) || output.reason || 'Blocked by hook';
  const stops = rule.discards === undefined;
  const systemMessage = rule.discards === 'common' ? undefined : output.systemMessage;
  return {
    continue: stops ? output.continue : undefined,
    stopReason: stops ? output.stopReason : undefined,
    systemMessage,
    suppressOutput: output.suppressOutput,
    hookSpecificOutput: specific,
    ...(blocked && { block: { reason } }),
    ...overCap({ systemMessage, ...injectedText(specific) }),
  };
}

/** The event-specific fields whose text is added to what Claude reads. */
function injectedText(specific: HookReading['hookSpecificOutput']) {
  if (!specific) return {};
  return {
    additionalContext: 'additionalContext' in specific ? specific.additionalContext : undefined,
    initialUserMessage: 'initialUserMessage' in specific ? specific.initialUserMessage : undefined,
  };
}

/** The path is the last line that is not blank, read after terminal escape codes are removed. */
function readWorktreePath(stdout: string): Stdout {
  const lines = stripVTControlCharacters(stdout).split('\n');
  const worktreePath = lines.findLast((line) => line.trim())?.trim();
  if (!worktreePath) return { error: 'The hook printed no worktree path' };
  return { reading: { hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath } } };
}

/** A schema failure names the first few issues and counts the rest. */
function schemaError(issues: z.ZodError['issues']): string {
  const shown = issues
    .slice(0, SHOWN_ISSUES)
    .map(({ path, message }) => `${path.join('.')}: ${message}`);
  if (issues.length > SHOWN_ISSUES) shown.push(`and ${issues.length - SHOWN_ISSUES} more`);
  return `Hook JSON output validation failed — ${shown.join('\n  - ')}`;
}

/** Parsed JSON checked against the output schema and the event it names. */
function validateOutput(event: HookEvent, rule: HookEventRule, json: Parsed): Stdout {
  const parsed = HOOK_OUTPUT.safeParse(json.value);
  if (!parsed.success) return { error: schemaError(parsed.error.issues) };
  const named = parsed.data.hookSpecificOutput?.hookEventName ?? event;
  if (named !== event) {
    return {
      error: `Failed to run: Hook returned incorrect event name: expected '${event}' but got '${named}'`,
    };
  }
  return { reading: readJson(event, rule, parsed.data) };
}

/** Stdout that starts like a JSON object: an async answer, a reading, plain text or an error. */
function readJsonText(event: HookEvent, rule: HookEventRule, text: string): Stdout {
  const whole = text.endsWith('}') ? parseJson(text) : {};
  // A background answer is the whole text, or the first line a hook that runs on prints first.
  const newline = text.indexOf('\n');
  const head = newline < 0 ? whole : parseJson(text.slice(0, newline));
  const answer = ASYNC_ANSWER.safeParse(whole.value ?? head.value);
  if (answer.success) return { async: { asyncTimeout: answer.data.asyncTimeout } };
  if (!text.endsWith('}')) return { text };
  if (whole.message === undefined) return validateOutput(event, rule, whole);
  if (isJsonLines(text)) return { text };
  return {
    error: `Hook output looks like a JSON object but is not valid JSON — ${whole.message}. Emit the payload with a JSON encoder (jq, ConvertTo-Json, json.dumps) rather than string concatenation so backslashes and quotes inside strings are escaped.`,
  };
}

/** Claude's rule for telling JSON from plain text, applied to the trimmed stdout. */
function readStdout(event: HookEvent, rule: HookEventRule, outcome: HookCommandOutcome): Stdout {
  if (rule.discards === 'output') return { text: '' };
  const text = outcome.stdout.trim();
  // A cut-short stream is never read as JSON, context or a path; other plain text is passed over.
  if (outcome.stdoutTruncated && (rule.stdout || !text || text.startsWith('{'))) {
    return { error: 'The hook printed more output than can be read' };
  }
  if (rule.stdout === 'path') return readWorktreePath(text);
  return text.startsWith('{') ? readJsonText(event, rule, text) : { text };
}

/** Exit code 2 blocks or tells; valid JSON is still read, and its blocking reason wins. */
function readExitTwo(rule: HookEventRule, stdout: Stdout, stderrReason: string): HookReading {
  const reading = 'reading' in stdout ? stdout.reading : {};
  if (rule.exit2 === 'tells-user') return { ...reading, error: stderrReason };
  const kept = rule.exit2DropsSpecific ? {} : reading;
  return { ...kept, block: { reason: reading.block?.reason ?? stderrReason } };
}

/** The exit code as the event reads it: some events ignore every code, or code 2 alone. */
function heededExit(rule: HookEventRule, code: number): number {
  const unheeded = rule.exit2 === 'ignored' || (rule.exit2 === 'unhonoured' && code === 2);
  return unheeded ? 0 : code;
}

/** Any exit but 2: valid JSON decides on its own, else a notice, an async answer or context. */
function readOtherExit(
  rule: HookEventRule,
  exit: number,
  stdout: Stdout,
  rawStderr: string,
): HookReading {
  if ('reading' in stdout) return stdout.reading;
  if ('error' in stdout) return failed(rule, 'failure', stdout.error);
  const stderr = rawStderr.trim() || NO_STDERR;
  if ('async' in stdout) {
    if (exit === 0) return { async: stdout.async };
    const text = `Announced async, then failed with status code ${exit}: ${stderr}`;
    return failed(rule, 'failure', text);
  }
  if (exit !== 0) return failed(rule, 'failure', `Failed with non-blocking status code: ${stderr}`);
  if (rule.stdout !== 'context' || !stdout.text) return {};
  return { context: stdout.text, ...overCap({ context: stdout.text }) };
}

/**
 * Reads the raw result of one command hook the way Claude Code does. `command` is how Claude
 * names the hook in a message: the command, followed by its arguments in exec form.
 */
export function readHookOutput(
  event: HookEvent,
  command: string,
  outcome: HookCommandOutcome,
): HookReading {
  const rule = HOOK_EVENT_RULES[event];
  if (outcome.startError !== undefined) {
    return failed(rule, 'failure', `Failed to run: ${outcome.startError}`);
  }
  if (outcome.timedOut) return failed(rule, 'timeout', 'Timed out; its output was discarded');
  // Like Claude, a hook that a signal ended counts as exit code 1.
  const code = outcome.exitCode ?? 1;
  if (code === 2 && rule.exit2 === 'ignored' && rule.exit2DropsSpecific) return {};
  const exit = heededExit(rule, code);
  const stderrReason = `[${command}]: ${outcome.stderr || NO_STDERR}`;
  if (exit !== 0 && rule.alsoBlocksOn === 'failure') return { block: { reason: stderrReason } };
  const stdout = readStdout(event, rule, outcome);
  if (exit === 2) return readExitTwo(rule, stdout, stderrReason);
  return readOtherExit(rule, exit, stdout, outcome.stderr);
}
