import type { HookEvent, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { type HookReading, readHookOutput } from './read-output';
import { runHookCommand } from './run-command';
import { selectHooks } from './select';

type Specific = NonNullable<HookReading['hookSpecificOutput']>;
type PermissionDecision = NonNullable<
  Extract<Specific, { hookEventName: 'PreToolUse' }>['permissionDecision']
>;
type ToolInputRewrite = Extract<Specific, { hookEventName: 'PreToolUse' }>['updatedInput'];
type RequestDecision = Extract<Specific, { hookEventName: 'PermissionRequest' }>['decision'];

/** Where and with what the hooks run; the caller decides all of it. */
export type HookRunContext = Pick<
  Parameters<typeof runHookCommand>[0],
  'cwd' | 'sessionCwd' | 'projectRoot' | 'env' | 'signal'
>;

/** One finished hook; `command` is how Claude names it in a message. */
type HookRan = { hook: HookRegistration; command: string; reading: HookReading };

/** What several hooks for one event come to, combined as Claude combines them. */
export type HookDispatch = {
  /** Every hook Claude would read, in the order each finished. */
  ran: HookRan[];
  /** Any one blocks; what a block does is the event's exit-2 rule. One reason per hook. */
  blocks: string[];
  /** Each hook's "hook error" notice; the action goes ahead. */
  errors: { command: string; error: string }[];
  /** Every `additionalContext` and plain-stdout context, one entry per hook. */
  context: string[];
  systemMessages: string[];
  /** A hook answered `continue: false`, which wins over every decision; the last reason given. */
  stop?: { reason?: string };
  /** PreToolUse and PreModelSwitch: the winning decision, its reason, and the rewrite that applies. */
  permission?: {
    decision?: PermissionDecision;
    reason?: string;
    updatedInput?: ToolInputRewrite;
  };
  /** PermissionRequest: the decision of the first hook to give one. */
  request?: RequestDecision;
};

/** Claude's lower default timeouts, in seconds, where the event sets one. */
const EVENT_TIMEOUT_SEC = new Map<HookEvent, number>([
  ['UserPromptSubmit', 30],
  ['PreModelSwitch', 30],
  ['PostModelSwitch', 30],
  ['MessageDisplay', 10],
]);
/** Claude's SessionEnd default and the most a SessionEnd hook's own timeout can raise it to. */
const SESSION_END_SEC = { default: 1.5, max: 60 };
/** Overrides the SessionEnd budget and default, in milliseconds. */
const SESSION_END_OVERRIDE = 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS';
const PRECEDENCE = { allow: 0, ask: 1, defer: 2, deny: 3 } satisfies Record<
  PermissionDecision,
  number
>;

/** The hook's timeout in seconds; undefined leaves the runner's 600-second default. */
export function hookTimeoutSec(
  event: HookEvent,
  hook: HookRegistration,
  env: HookRunContext['env'],
): number | undefined {
  if (event !== 'SessionEnd') return hook.timeoutSec ?? EVENT_TIMEOUT_SEC.get(event);
  const override = Number(env[SESSION_END_OVERRIDE]) / 1000;
  if (override > 0) return Math.min(hook.timeoutSec ?? override, override);
  // A hook's own timeout raises the shared budget; a hook without one keeps the default.
  return Math.min(hook.timeoutSec ?? SESSION_END_SEC.default, SESSION_END_SEC.max);
}

/** Claude acts on these at once and reads no hook that finishes later. */
function settles(event: HookEvent, reading: HookReading): boolean {
  if (event === 'PermissionRequest') return reading.hookSpecificOutput !== undefined;
  const prompt = event === 'UserPromptSubmit' || event === 'UserPromptExpansion';
  return prompt && (!!reading.block || reading.continue === false);
}

/** Each hook's context; Claude ignores the context of a hook that defers the tool call. */
function contextOf(reading: HookReading): string[] {
  const specific = reading.hookSpecificOutput;
  if (specific?.hookEventName === 'PreToolUse' && specific.permissionDecision === 'defer')
    return [];
  const added =
    specific && 'additionalContext' in specific ? specific.additionalContext : undefined;
  return [reading.context, added].flatMap((text) => (text ? [text] : []));
}

type Vote = { decision?: PermissionDecision; reason?: string; rewrite?: ToolInputRewrite };

/** One hook's vote: a block counts as deny and wins over the decision it printed. */
function vote(reading: HookReading): Vote {
  if (reading.block) return { decision: 'deny', reason: reading.block.reason };
  const specific = reading.hookSpecificOutput;
  if (specific?.hookEventName === 'PreModelSwitch') {
    return { decision: specific.permissionDecision, reason: specific.permissionDecisionReason };
  }
  if (specific?.hookEventName !== 'PreToolUse') return {};
  const { permissionDecision: decision, permissionDecisionReason: reason } = specific;
  return { decision, reason, rewrite: specific.updatedInput };
}

/** A tie goes to the hook that finished later. */
function outranks(cast: Vote, winner: Vote): boolean {
  if (!cast.decision) return false;
  return !winner.decision || PRECEDENCE[cast.decision] >= PRECEDENCE[winner.decision];
}

/** A bare rewrite always counts; one with a decision only if it is an allow or ask that leads. */
function keepsRewrite({ decision }: Vote, leads: boolean): boolean {
  if (!decision) return true;
  return leads && (decision === 'allow' || decision === 'ask');
}

/** Deny > defer > ask > allow; a decision's rewrite counts only if it leads when it arrives. */
function decide(readings: HookReading[]): HookDispatch['permission'] {
  let winner: Vote = {};
  let updatedInput: ToolInputRewrite;
  for (const reading of readings) {
    const cast = vote(reading);
    const leads = outranks(cast, winner);
    if (leads) winner = cast;
    if (cast.rewrite && keepsRewrite(cast, leads)) updatedInput = cast.rewrite;
  }
  const { decision, reason } = winner;
  if (!decision && !updatedInput) return undefined;
  return { decision, reason, updatedInput: decision === 'deny' ? undefined : updatedInput };
}

function firstRequest(readings: HookReading[]): RequestDecision | undefined {
  for (const { hookSpecificOutput: specific } of readings) {
    if (specific?.hookEventName === 'PermissionRequest') return specific.decision;
  }
  return undefined;
}

/** Combines the readings of one event's hooks, given in the order they finished. */
export function combineHookReadings(event: HookEvent, ran: HookRan[]): HookDispatch {
  const readings = ran.map(({ reading }) => reading);
  const permission =
    event === 'PreToolUse' || event === 'PreModelSwitch' ? decide(readings) : undefined;
  const stops = readings.filter((reading) => reading.continue === false);
  return {
    ran,
    blocks: readings.flatMap(({ block }) => (block ? [block.reason] : [])),
    errors: ran.flatMap(({ command, reading: { error } }) =>
      error === undefined ? [] : [{ command, error }],
    ),
    context: readings.flatMap(contextOf),
    systemMessages: readings.flatMap(({ systemMessage }) => (systemMessage ? [systemMessage] : [])),
    stop: stops.length
      ? { reason: stops.findLast(({ stopReason }) => stopReason)?.stopReason }
      : undefined,
    permission,
    request: event === 'PermissionRequest' ? firstRequest(readings) : undefined,
  };
}

async function runOne(
  hook: HookRegistration,
  input: HookInput,
  context: HookRunContext,
): Promise<HookRan> {
  const event = input.hook_event_name;
  const command = hook.command ?? '';
  const timeout = hookTimeoutSec(event, hook, context.env);
  const outcome = await runHookCommand({
    ...context,
    command,
    args: hook.args,
    timeoutSec: timeout,
    input,
  });
  const name = hook.args ? [command, ...hook.args].join(' ') : command;
  return { hook, command: name, reading: readHookOutput(event, name, outcome) };
}

/**
 * Runs every bound hook that matches the input at once; readings are combined in finishing order.
 * Resolves early where Claude stops reading; slower hooks then run until `context.signal` aborts.
 */
export function dispatchHooks(
  hooks: HookRegistration[],
  input: HookInput,
  context: HookRunContext,
): Promise<HookDispatch> {
  const event = input.hook_event_name;
  const selected = selectHooks(hooks, input);
  const ran: HookRan[] = [];
  return new Promise((resolve, reject) => {
    const runs = selected.map(async (hook) => {
      const finished = await runOne(hook, input, context);
      ran.push(finished);
      if (settles(event, finished.reading)) resolve(combineHookReadings(event, [...ran]));
    });
    Promise.all(runs).then(() => resolve(combineHookReadings(event, ran)), reject);
  });
}
