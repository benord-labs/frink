import type {
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { combineHookReadings, dispatchHooks, type HookDispatch, type TurnHooks } from './dispatch';

type OwnOutput = Omit<PreToolUseHookSpecificOutput, 'hookEventName' | 'additionalContext'>;

/** What one tool call's user hooks came to, in the terms Frink's permission gate acts on. */
export type PreToolUseHooks = {
  /** A hook denied the call, exited 2 or asked to confirm it, or the call was cancelled. */
  deny?: string;
  /** Replaces the whole tool input: every later check judges it and it is what runs. */
  updatedInput?: PreToolUseHookSpecificOutput['updatedInput'];
  additionalContext?: string;
  /** Sent with the gate's answer whatever it decides: warnings for the user, and a stop. */
  common: Pick<SyncHookJSONOutput, 'continue' | 'stopReason' | 'systemMessage'>;
};

export const NO_HOOKS: PreToolUseHooks = { common: {} };
const CANCELLED = 'This tool call was cancelled while its hooks were running.';
const UNANSWERED = 'A hook asked to confirm this call, which Frink cannot prompt for yet.';

/** A hook that blocks never counts as deferring: its block stands whatever its JSON says. */
function defers({ reading }: HookDispatch['ran'][number]): boolean {
  const specific = reading.hookSpecificOutput;
  const deferred =
    specific?.hookEventName === 'PreToolUse' && specific.permissionDecision === 'defer';
  return deferred && !reading.block;
}

/** Why the hooks stop the call, if they do. Frink has no prompt for a hook's "ask" yet. */
function denial({ blocks, permission }: HookDispatch): string | undefined {
  if (blocks.length > 0) return blocks.join('\n');
  if (permission?.decision !== 'ask') return undefined;
  return permission.reason ? `${UNANSWERED} Its reason: ${permission.reason}` : UNANSWERED;
}

/** The user's warnings: each hook's own message, then Claude's "hook error" notice per failure. */
function notices(toolName: string, dispatch: HookDispatch): string[] {
  for (const { hook, reading } of dispatch.ran) {
    if (reading.error === undefined) continue;
    log.warn('[hooks] PreToolUse hook error', { toolName, hook: hook.label, file: hook.file });
  }
  const errors = dispatch.errors.map(({ error }) => `PreToolUse:${toolName} hook error: ${error}`);
  return [...dispatch.systemMessages, ...errors];
}

/** Reads the combined result of a tool call's hooks as Claude's hooks reference defines it. */
export function readPreToolUseDispatch(toolName: string, dispatch: HookDispatch): PreToolUseHooks {
  if (dispatch.ran.some(defers)) {
    // With a user present Claude ignores a deferring hook's whole result; the others still count.
    log.warn('[hooks] Ignored a PreToolUse hook that deferred a tool call', { toolName });
    const others = dispatch.ran.filter((ran) => !defers(ran));
    return readPreToolUseDispatch(toolName, combineHookReadings('PreToolUse', others));
  }
  const { permission, stop } = dispatch;
  const warnings = notices(toolName, dispatch);
  return {
    deny: denial(dispatch),
    updatedInput: permission?.updatedInput,
    additionalContext: dispatch.context.join('\n') || undefined,
    common: {
      ...(stop && { continue: false, stopReason: stop.reason }),
      ...(warnings.length > 0 && { systemMessage: warnings.join('\n') }),
    },
  };
}

/** Runs the turn's bound hooks for one tool call; with none bound, nothing runs. */
export async function runPreToolUseHooks(
  bound: TurnHooks | undefined,
  input: PreToolUseHookInput,
  options: { signal: AbortSignal },
): Promise<PreToolUseHooks> {
  if (!bound) return NO_HOOKS;
  const context = { ...bound.context, signal: options.signal };
  const dispatch = await dispatchHooks(bound.hooks, input, context);
  if (options.signal.aborted) return { ...NO_HOOKS, deny: CANCELLED };
  return readPreToolUseDispatch(input.tool_name, dispatch);
}

/** The gate's answer to Claude: its own decision, plus what the hooks add whatever it decides. */
export function preToolUseOutput(hooks: PreToolUseHooks, own: OwnOutput): SyncHookJSONOutput {
  const { additionalContext } = hooks;
  const specific = additionalContext === undefined ? own : { ...own, additionalContext };
  const said = Object.values(specific).some((value) => value !== undefined);
  return {
    ...hooks.common,
    ...(said && { hookSpecificOutput: { hookEventName: 'PreToolUse', ...specific } }),
  };
}
