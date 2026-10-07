import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { HookRegistration } from '../../../../../shared/types/hook-inventory';
import type { ClaudeSession } from '../../claude-session-registry';
import { createClaudeTurnContext } from '../../claude-turn-context';
import type { validateToolPermission } from '../../streaming/pending-permission/validate-tool-permission';
import { buildClaudeSessionCallbacks } from './session-callbacks';

type Verdict = Awaited<ReturnType<typeof validateToolPermission>>;

const signal = new AbortController().signal;

function toolCall(tool_name: string, tool_input: PreToolUseHookInput['tool_input']) {
  const input: PreToolUseHookInput = {
    session_id: 's',
    transcript_path: '/dev/null',
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 'tool-1',
  };
  return input;
}

/** A hook that runs the given shell text for every tool. */
function hook(command: string): HookRegistration {
  return {
    id: `project:PreToolUse:0:${command}`,
    scope: 'project',
    file: '/work/.claude/settings.json',
    event: 'PreToolUse',
    handlerType: 'command',
    label: 'inline shell script',
    command,
    binding: { status: 'supported', ignored: [] },
  };
}
const prints = (output: SyncHookJSONOutput) => hook(`printf '%s' '${JSON.stringify(output)}'`);
const pre = (fields: Omit<PreToolUseHookSpecificOutput, 'hookEventName'>): SyncHookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields },
});

/** Frink's gate on a turn whose bound hooks are the ones given; the rules answer as scripted. */
function gate(hooks: HookRegistration[] | undefined, rules: () => Verdict) {
  const turn = createClaudeTurnContext();
  if (hooks) {
    // Hooks get a constructed environment, never the test process's own.
    const context = {
      cwd: '/tmp',
      sessionCwd: '/tmp',
      projectRoot: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
    };
    turn.execution.userHooks = { hooks, context };
  }
  const validate = vi.fn<typeof validateToolPermission>(async () => rules());
  // SAFETY: the gate reads only the session's attached turn.
  const session = { current: { currentTurn: turn } as ClaudeSession };
  const scope = {
    chatId: 'chat',
    subChatId: 'sub',
    project: null,
    projectPath: '/work',
    permissionProjectPath: '/work',
    agents: {},
    validateToolPermission: validate,
    abortSources: new Map<string, string>(),
  };
  const run = buildClaudeSessionCallbacks(scope, session).hooks.PreToolUse[0].hooks[0];
  return {
    turn,
    validate,
    run: (input: PreToolUseHookInput, during = signal) => run(input, 'tool-1', { signal: during }),
  };
}

const bash = toolCall('Bash', { command: 'ls' });
const registerNode = toolCall('mcp__frink_dynamic_chat__frink_register_node', {});
const allowRule = (): Verdict => ({ allowed: true });
const allowed = pre({ permissionDecision: 'allow', updatedInput: { command: 'ls' } });

describe("the user's PreToolUse hooks inside Frink's gate", () => {
  it('with no hooks bound or matched, answers exactly as before and judges once', async () => {
    const ungated = gate(undefined, allowRule);
    expect(await ungated.run(toolCall('TodoWrite', {}))).toEqual({});
    const gated = gate(undefined, allowRule);
    expect(await gated.run(bash)).toEqual(allowed);
    expect(gated.validate).toHaveBeenCalledTimes(1);
    const unmatched = gate([{ ...hook('exit 2'), matcher: 'Write' }], allowRule);
    expect(await unmatched.run(bash)).toEqual(allowed);
  });

  it("judges and runs the input a hook rewrote, and passes on the hook's context", async () => {
    const updatedInput = { file_path: '/etc/hosts', content: '' };
    const { run, validate } = gate(
      [prints(pre({ updatedInput, additionalContext: 'note' }))],
      allowRule,
    );
    const answer = await run(toolCall('Write', { file_path: '/work/a.txt', content: '' }));
    expect(answer).toEqual(
      pre({ permissionDecision: 'allow', updatedInput, additionalContext: 'note' }),
    );
    expect(validate.mock.calls[0][1]).toEqual(updatedInput);
    expect(validate.mock.calls[0][6]).toBe('/etc/hosts');
  });

  it("denies on exit code 2 before Frink's rules run, and records the reason", async () => {
    const { run, validate, turn } = gate([hook('echo no >&2; exit 2')], allowRule);
    const answer = await run(bash);
    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(turn.deniedToolIdsWithMessages.get('tool-1')).toContain('no');
    expect(validate).not.toHaveBeenCalled();
  });

  it('reads the tool call on stdin, and keeps the stop of a hook that denies it', async () => {
    const denies = pre({ permissionDecision: 'deny', permissionDecisionReason: 'no' });
    const stopped = { ...denies, continue: false, stopReason: 'halt' };
    const policy = hook(`grep -q 'rm -rf' && printf '%s' '${JSON.stringify(stopped)}'; exit 0`);
    const { run } = gate([policy], allowRule);
    expect(await run(toolCall('Bash', { command: 'rm -rf /' }))).toEqual(stopped);
    expect(await run(bash)).toEqual(allowed);
  });

  it('stops a call whose plan was submitted while its hooks were rewriting it', async () => {
    const marker = path.join(os.tmpdir(), randomUUID());
    const rewrite = JSON.stringify(pre({ updatedInput: { command: 'pwd' } }));
    const { run, turn, validate } = gate(
      [hook(`touch ${marker}; printf '%s' '${rewrite}'`)],
      allowRule,
    );
    turn.planSubmissionHalt = () => fs.existsSync(marker);
    const answer = await run(bash);
    fs.rmSync(marker);
    expect(answer.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Plan submitted'),
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('stops the hooks of a call cancelled while they run, and denies the call', async () => {
    const { run, validate } = gate([hook('sleep 30')], allowRule);
    const answer = await run(bash, AbortSignal.timeout(50));
    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(validate).not.toHaveBeenCalled();
  });

  it('lets the call go ahead when a hook fails, with a notice for the user', async () => {
    const { run } = gate([hook('echo boom >&2; exit 1')], allowRule);
    expect(await run(bash)).toEqual({
      ...allowed,
      systemMessage: 'PreToolUse:Bash hook error: Failed with non-blocking status code: boom',
    });
  });

  it('passes a rewrite and a stop on to Claude without denying a tool Frink has no rules for', async () => {
    // A stop outranks the hook's ask, so Frink's rules decide alone: here, nothing to decide.
    const stop = { continue: false, stopReason: 'halt' };
    const asks = pre({ permissionDecision: 'ask', updatedInput: { todos: [] } });
    const { run, validate } = gate([prints({ ...asks, ...stop })], allowRule);
    expect(await run(toolCall('TodoWrite', {}))).toEqual({
      ...pre({ updatedInput: { todos: [] } }),
      ...stop,
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("denies a rewrite Frink's rules deny, still sending the hooks' context and stop", async () => {
    const updatedInput = { command: 'rm -rf /' };
    const extras = { continue: false, stopReason: 'halt', systemMessage: 'careful' };
    const allows = pre({ permissionDecision: 'allow', updatedInput, additionalContext: 'note' });
    const denyRule = (): Verdict => ({ allowed: false, message: 'Denied by rule' });
    const { run, validate, turn } = gate([prints({ ...allows, ...extras })], denyRule);
    const reason = 'Denied by rule';
    expect(await run(bash)).toEqual({
      ...pre({
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
        additionalContext: 'note',
      }),
      ...extras,
    });
    expect(validate.mock.calls[0][1]).toEqual(updatedInput);
    expect(turn.deniedToolIdsWithMessages.get('tool-1')).toBe(reason);
  });

  it('denies a plan transition in a wake burst whatever a hook says', async () => {
    const allows = pre({ permissionDecision: 'allow', updatedInput: {} });
    const { run, validate, turn } = gate([prints(allows)], allowRule);
    turn.isWakeBurst = true;
    expect((await run(toolCall('EnterPlanMode', {}))).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([
    ['a gated tool', bash],
    ['a tool Frink has no rules for', toolCall('TodoWrite', {})],
    ['frink_register_node', registerNode],
  ])("hands a hook's ask on %s to the rules and card, with its reason", async (_, call) => {
    const asks = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check this' });
    const { run, validate } = gate([prints(asks)], allowRule);
    expect((await run(call)).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    expect(validate.mock.calls[0][13]).toEqual({ decision: 'ask', reason: 'check this' });
  });

  it("allows a tool Frink has no rules for on a hook's allow, unless the rules deny it", async () => {
    const allows = prints(pre({ permissionDecision: 'allow' }));
    const { run, validate } = gate([allows], allowRule);
    const todo = toolCall('TodoWrite', {});
    expect((await run(todo)).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    expect(validate.mock.calls[0][13]).toEqual({ decision: 'allow' });
    const denied = gate([allows], () => ({ allowed: false, message: 'Denied by rule' }));
    expect((await denied.run(todo)).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
    });
  });

  it.each([
    ['AskUserQuestion', toolCall('AskUserQuestion', {})],
    ['ExitPlanMode', toolCall('ExitPlanMode', {})],
  ])("leaves %s to its own flow whatever a hook's ask says", async (_, call) => {
    const asks = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check this' });
    const { run, validate } = gate([prints(asks)], allowRule);
    expect(await run(call)).toEqual({});
    expect(validate).not.toHaveBeenCalled();
  });
});
