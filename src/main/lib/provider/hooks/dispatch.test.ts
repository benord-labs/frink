import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HookEvent, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookRegistration } from '../../../../shared/types/hook-inventory';
import { combineHookReadings, hookTimeoutSec } from './dispatch';
import { dispatchHooks } from './index';
import type { HookReading } from './read-output';

const BASE = { session_id: 's', transcript_path: '/dev/null', cwd: '/work' };
const PROMPT: HookInput = { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
const EXPANSION: HookInput = {
  ...BASE,
  hook_event_name: 'UserPromptExpansion',
  expansion_type: 'slash_command',
  command_name: 'review',
  command_args: '',
  prompt: '/review',
};
// Hooks get a constructed environment, never the test process's own.
const ENV = { PATH: '/usr/bin:/bin' };

function hook(event: string, command: string, fields: Partial<HookRegistration> = {}) {
  const registration: HookRegistration = {
    id: `project:${event}:0:${command}`,
    scope: 'project',
    file: '/work/.claude/settings.json',
    event,
    handlerType: 'command',
    label: 'inline shell script',
    command,
    binding: { status: 'supported', ignored: [] },
    ...fields,
  };
  return registration;
}

/** Readings in the order the hooks finished, each from a hook named after its place. */
function combine(event: HookEvent, readings: HookReading[]) {
  const ran = readings.map((reading, i) => ({
    hook: hook(event, `hook-${i}`),
    command: `hook-${i}`,
    reading,
  }));
  return combineHookReadings(event, ran);
}

type PreToolUseOutput = Extract<
  NonNullable<HookReading['hookSpecificOutput']>,
  { hookEventName: 'PreToolUse' }
>;

function pre(fields: Omit<PreToolUseOutput, 'hookEventName'>): HookReading {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } };
}

describe('combineHookReadings on PreToolUse', () => {
  it('ranks deny over defer over ask over allow, whatever order they finish in', () => {
    const allow = pre({ permissionDecision: 'allow' });
    const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check' });
    const defer = pre({ permissionDecision: 'defer' });
    const deny: HookReading = { ...pre({ permissionDecision: 'deny' }), block: { reason: 'no' } };
    expect(combine('PreToolUse', [deny, allow]).permission?.decision).toBe('deny');
    expect(combine('PreToolUse', [deny, defer]).permission?.decision).toBe('deny');
    expect(combine('PreToolUse', [defer, deny]).permission?.decision).toBe('deny');
    expect(combine('PreToolUse', [ask, defer, allow]).permission?.decision).toBe('defer');
    expect(combine('PreToolUse', [allow, ask]).permission).toEqual({
      decision: 'ask',
      reason: 'check',
      updatedInput: undefined,
    });
  });

  it('counts an exit-2 block as deny, with its reason', () => {
    const blocked: HookReading = { block: { reason: '[guard]: stop' } };
    const result = combine('PreToolUse', [pre({ permissionDecision: 'allow' }), blocked]);
    expect(result.permission).toEqual({ decision: 'deny', reason: '[guard]: stop' });
    expect(result.blocks).toEqual(['[guard]: stop']);
  });

  it('takes the reason from the last hook to finish with the winning decision', () => {
    const first = pre({ permissionDecision: 'ask', permissionDecisionReason: 'first' });
    const second = pre({ permissionDecision: 'ask', permissionDecisionReason: 'second' });
    expect(combine('PreToolUse', [first, second]).permission?.reason).toBe('second');
  });

  it('applies the last rewrite, which a later allow or ask without one does not clear', () => {
    const p = pre({ permissionDecision: 'allow', updatedInput: { command: 'echo P' } });
    const q = pre({ permissionDecision: 'allow', updatedInput: { command: 'echo Q' } });
    const r = pre({ permissionDecision: 'allow' });
    expect(combine('PreToolUse', [p, q, r]).permission?.updatedInput).toEqual({
      command: 'echo Q',
    });
    const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check' });
    expect(combine('PreToolUse', [p, ask]).permission).toEqual({
      decision: 'ask',
      reason: 'check',
      updatedInput: { command: 'echo P' },
    });
  });

  it('ignores the rewrite of a decision that does not lead when its hook finishes', () => {
    const ask = pre({ permissionDecision: 'ask', permissionDecisionReason: 'confirm' });
    const allowB = pre({ permissionDecision: 'allow', updatedInput: { command: 'echo B' } });
    expect(combine('PreToolUse', [ask, allowB]).permission).toEqual({
      decision: 'ask',
      reason: 'confirm',
      updatedInput: undefined,
    });
    const askA = pre({ permissionDecision: 'ask', updatedInput: { command: 'echo A' } });
    expect(combine('PreToolUse', [askA, allowB]).permission?.updatedInput).toEqual({
      command: 'echo A',
    });
    const defer = pre({ permissionDecision: 'defer' });
    expect(combine('PreToolUse', [defer, allowB]).permission).toEqual({ decision: 'defer' });
  });

  it('applies a rewrite that comes with no decision', () => {
    expect(combine('PreToolUse', [pre({ updatedInput: { a: 1 } })]).permission).toEqual({
      updatedInput: { a: 1 },
    });
  });

  it("ignores a deferring hook's own rewrite and context, and any rewrite when denied", () => {
    const rewrite = pre({
      permissionDecision: 'allow',
      updatedInput: { a: 1 },
      additionalContext: 'kept',
    });
    const deferred = combine('PreToolUse', [
      rewrite,
      pre({ permissionDecision: 'defer', updatedInput: { b: 2 }, additionalContext: 'dropped' }),
    ]);
    expect(deferred.permission).toEqual({ decision: 'defer', updatedInput: { a: 1 } });
    expect(deferred.context).toEqual(['kept']);
    const denied = combine('PreToolUse', [rewrite, { block: { reason: 'no' } }]);
    expect(denied.permission?.updatedInput).toBeUndefined();
    expect(denied.context).toEqual(['kept']);
  });

  it('decides nothing when no hook does', () => {
    expect(combine('PreToolUse', [{}, { systemMessage: 'hi' }]).permission).toBeUndefined();
  });
});

describe('combineHookReadings on other events', () => {
  it('ranks PreModelSwitch deny over ask over allow, with the winning reason', () => {
    const vote = (permissionDecision: 'allow' | 'ask' | 'deny'): HookReading => ({
      hookSpecificOutput: {
        hookEventName: 'PreModelSwitch',
        permissionDecision,
        permissionDecisionReason: permissionDecision,
      },
    });
    expect(combine('PreModelSwitch', [vote('ask'), vote('allow')]).permission).toEqual({
      decision: 'ask',
      reason: 'ask',
      updatedInput: undefined,
    });
    const denied = combine('PreModelSwitch', [vote('deny'), vote('ask'), vote('allow')]);
    expect(denied.permission?.reason).toBe('deny');
    const timedOut = combine('PreModelSwitch', [vote('allow'), { block: { reason: 'timed out' } }]);
    expect(timedOut.permission?.decision).toBe('deny');
  });

  it('takes the first PermissionRequest decision, with no precedence', () => {
    const decide = (behavior: 'allow' | 'deny'): HookReading => ({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } },
    });
    expect(combine('PermissionRequest', [{}, decide('allow'), decide('deny')]).request).toEqual({
      behavior: 'allow',
    });
  });

  it('delivers every context, message, block and notice, one per hook', () => {
    const result = combine('UserPromptSubmit', [
      { context: 'plain', systemMessage: 'one' },
      {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'json' },
        systemMessage: 'two',
      },
      { error: 'Failed with non-blocking status code: boom' },
    ]);
    expect(result.context).toEqual(['plain', 'json']);
    expect(result.systemMessages).toEqual(['one', 'two']);
    const empty = combine('UserPromptSubmit', [
      {
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '' },
        systemMessage: '',
      },
    ]);
    expect(empty).toMatchObject({ context: [], systemMessages: [] });
    expect(result.errors).toEqual([
      { command: 'hook-2', error: 'Failed with non-blocking status code: boom' },
    ]);
    expect(
      combine('Stop', [{ block: { reason: 'a' } }, { block: { reason: 'b' } }]).blocks,
    ).toEqual(['a', 'b']);
  });

  it('stops on any continue false, with the last reason given', () => {
    const result = combine('Stop', [
      { continue: false, stopReason: 'first' },
      { continue: true, stopReason: 'ignored' },
      { continue: false, stopReason: 'last' },
      { continue: false },
    ]);
    expect(result.stop).toEqual({ reason: 'last' });
    expect(combine('Stop', [{ continue: true }]).stop).toBeUndefined();
    expect(combine('Stop', [{}, { systemMessage: 'hi' }]).stop).toBeUndefined();
  });
});

describe('hookTimeoutSec', () => {
  it('lowers the default on the events Claude lowers it on', () => {
    const plain = hook('UserPromptSubmit', 'x');
    expect(hookTimeoutSec('UserPromptSubmit', plain, ENV)).toBe(30);
    expect(hookTimeoutSec('PreModelSwitch', plain, ENV)).toBe(30);
    expect(hookTimeoutSec('PostModelSwitch', plain, ENV)).toBe(30);
    expect(hookTimeoutSec('MessageDisplay', plain, ENV)).toBe(10);
    expect(hookTimeoutSec('PreToolUse', plain, ENV)).toBeUndefined();
    const own = hook('UserPromptSubmit', 'y', { timeoutSec: 90 });
    expect(hookTimeoutSec('UserPromptSubmit', own, ENV)).toBe(90);
  });

  it('keeps SessionEnd hooks without a timeout at 1.5 seconds and caps the rest at 60', () => {
    const plain = hook('SessionEnd', 'x');
    expect(hookTimeoutSec('SessionEnd', plain, ENV)).toBe(1.5);
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'y', { timeoutSec: 5 }), ENV)).toBe(5);
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'z', { timeoutSec: 300 }), ENV)).toBe(
      60,
    );
  });

  it('lets the SessionEnd override set the budget and the default', () => {
    const env = { ...ENV, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000' };
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'x'), env)).toBe(5);
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'y', { timeoutSec: 2 }), env)).toBe(2);
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'z', { timeoutSec: 90 }), env)).toBe(5);
    const unreadable = { ...ENV, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: 'soon' };
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'x'), unreadable)).toBe(1.5);
    // Claude reads the override as an integer of at least 1, so 0 leaves it unset.
    const zero = { ...ENV, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '0' };
    expect(hookTimeoutSec('SessionEnd', hook('SessionEnd', 'x'), zero)).toBe(1.5);
  });
});

describe('dispatchHooks', () => {
  let dir: string;
  // Aborted after each test, which stops any hook the dispatch settled without.
  let stop: AbortController;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frink-dispatch-'));
    stop = new AbortController();
  });
  afterEach(async () => {
    stop.abort();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function context() {
    return { cwd: dir, sessionCwd: dir, projectRoot: dir, env: ENV, signal: stop.signal };
  }

  /** A shell hook that waits, then prints a PreToolUse decision. */
  function deciding(permissionDecision: 'allow' | 'deny', delaySec = 0): string {
    const json = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision } };
    return `sleep ${delaySec}; printf '%s' '${JSON.stringify(json)}'`;
  }

  const bashCall: HookInput = {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: 't',
  };

  it('runs the matching hooks at once and folds them in the order they finish', async () => {
    const hooks = [
      hook('PreToolUse', deciding('deny', 0.4), { matcher: 'Bash' }),
      hook('PreToolUse', deciding('allow'), { matcher: 'Edit|Bash' }),
      hook('PreToolUse', 'touch never-run', { matcher: 'Edit' }),
    ];
    const started = Date.now();
    const result = await dispatchHooks(hooks, bashCall, context());
    expect(result.ran.map(({ hook: { matcher } }) => matcher)).toEqual(['Edit|Bash', 'Bash']);
    expect(result.permission?.decision).toBe('deny');
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(fs.stat(path.join(dir, 'never-run'))).rejects.toThrow();
  });

  it('names an exec-form hook by its command and arguments', async () => {
    const result = await dispatchHooks(
      [
        hook('PreToolUse', '/bin/sh', { args: ['-c', 'echo boom >&2; exit 2'] }),
        hook('PreToolUse', '/bin/sh', { args: ['-c', 'exit 1'] }),
      ],
      bashCall,
      context(),
    );
    expect(result.blocks).toEqual(['[/bin/sh -c echo boom >&2; exit 2]: boom\n']);
    expect(result.errors.map(({ command }) => command)).toEqual(['/bin/sh -c exit 1']);
  });

  it('settles on the first prompt block without waiting for slower hooks', async () => {
    const hooks = [
      hook('UserPromptSubmit', 'sleep 10'),
      hook('UserPromptSubmit', 'echo no >&2; exit 2'),
    ];
    const started = Date.now();
    const result = await dispatchHooks(hooks, PROMPT, context());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.blocks).toEqual(['[echo no >&2; exit 2]: no\n']);
    expect(result.ran).toHaveLength(1);
  });

  it('settles on the first PermissionRequest decision without waiting for slower hooks', async () => {
    const request: HookInput = { ...bashCall, hook_event_name: 'PermissionRequest' };
    const allow = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    const hooks = [
      hook('PermissionRequest', 'sleep 10'),
      hook('PermissionRequest', `printf '%s' '${JSON.stringify(allow)}'`),
    ];
    const started = Date.now();
    const result = await dispatchHooks(hooks, request, context());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.request).toEqual({ behavior: 'allow' });
    expect(result.ran).toHaveLength(1);
  });

  it('waits past a fast PermissionRequest hook that gives no decision', async () => {
    const request: HookInput = { ...bashCall, hook_event_name: 'PermissionRequest' };
    const deny = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    };
    const hooks = [
      hook('PermissionRequest', 'true'),
      hook('PermissionRequest', `sleep 0.3; printf '%s' '${JSON.stringify(deny)}'`),
    ];
    const result = await dispatchHooks(hooks, request, context());
    expect(result.request).toEqual({ behavior: 'deny' });
    expect(result.ran).toHaveLength(2);
  });

  it('waits past a fast prompt hook that does not block', async () => {
    const hooks = [
      hook('UserPromptSubmit', 'true'),
      hook('UserPromptSubmit', 'sleep 0.3; echo late >&2; exit 2'),
    ];
    const result = await dispatchHooks(hooks, PROMPT, context());
    expect(result.blocks).toEqual(['[sleep 0.3; echo late >&2; exit 2]: late\n']);
    expect(result.ran).toHaveLength(2);
  });

  it('settles on the first UserPromptExpansion block', async () => {
    const hooks = [
      hook('UserPromptExpansion', 'sleep 0.3; touch late'),
      hook('UserPromptExpansion', 'echo no >&2; exit 2'),
    ];
    const result = await dispatchHooks(hooks, EXPANSION, context());
    // The slower hook finishes after the settle and is not added to the result.
    await vi.waitFor(() => fs.stat(path.join(dir, 'late')), { timeout: 5000 });
    await new Promise((done) => setTimeout(done, 200));
    expect(result.ran).toHaveLength(1);
    expect(result.blocks).toEqual(['[echo no >&2; exit 2]: no\n']);
  });

  it('settles on the first prompt continue false, with its reason', async () => {
    const quit = (reason: string) => `printf '%s' '{"continue":false,"stopReason":"${reason}"}'`;
    for (const input of [PROMPT, EXPANSION]) {
      const event = input.hook_event_name;
      const hooks = [hook(event, `sleep 10; ${quit('slow')}`), hook(event, quit('fast'))];
      const result = await dispatchHooks(hooks, input, context());
      expect(result.stop).toEqual({ reason: 'fast' });
      expect(result.ran).toHaveLength(1);
    }
  });

  it('waits past a fast continue false outside the prompt events', async () => {
    const stopInput: HookInput = { ...BASE, hook_event_name: 'Stop', stop_hook_active: false };
    for (const input of [stopInput, bashCall]) {
      const event = input.hook_event_name;
      const hooks = [hook(event, `printf '%s' '{"continue":false}'`), hook(event, 'sleep 0.3')];
      const result = await dispatchHooks(hooks, input, context());
      expect(result.stop).toEqual({ reason: undefined });
      expect(result.ran).toHaveLength(2);
    }
  });

  it('waits for every Stop hook and delivers each block', async () => {
    const stopInput: HookInput = { ...BASE, hook_event_name: 'Stop', stop_hook_active: false };
    const hooks = [
      hook('Stop', 'echo a >&2; exit 2'),
      hook('Stop', 'sleep 0.3; echo b >&2; exit 2'),
    ];
    const result = await dispatchHooks(hooks, stopInput, context());
    expect(result.blocks).toEqual([
      '[echo a >&2; exit 2]: a\n',
      '[sleep 0.3; echo b >&2; exit 2]: b\n',
    ]);
  });

  it('gives every hook the original input', async () => {
    const hooks = [
      hook('UserPromptSubmit', "printf 'a:'; cat"),
      hook('UserPromptSubmit', "printf 'b:'; cat"),
    ];
    const result = await dispatchHooks(hooks, PROMPT, context());
    const sent =
      '{"session_id":"s","transcript_path":"/dev/null","cwd":"/work","hook_event_name":"UserPromptSubmit","prompt":"hi"}';
    expect([...result.context].sort()).toEqual([`a:${sent}`, `b:${sent}`]);
  });

  it('stops a SessionEnd hook without a timeout at 1.5 seconds beside one with its own', async () => {
    const end: HookInput = { ...BASE, hook_event_name: 'SessionEnd', reason: 'other' };
    const hooks = [
      hook('SessionEnd', 'sleep 5', { timeoutSec: 2.5 }),
      hook('SessionEnd', 'sleep 4'),
    ];
    const started = Date.now();
    const result = await dispatchHooks(hooks, end, context());
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.ran.map(({ hook: { command } }) => command)).toEqual(['sleep 4', 'sleep 5']);
    expect(result.errors.map(({ error }) => error)).toEqual([
      expect.stringMatching(/Timed out/),
      expect.stringMatching(/Timed out/),
    ]);
  });

  it('resolves with nothing when no hook matches', async () => {
    const result = await dispatchHooks([], bashCall, context());
    expect(result).toMatchObject({ ran: [], blocks: [], context: [] });
  });
});
