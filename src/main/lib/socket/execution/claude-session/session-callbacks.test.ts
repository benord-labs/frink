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
import { REQUIRED_TOOLS } from '../../../../../shared/types/permissions';
import type { ClaudeSession } from '../../claude-session-registry';
import { createClaudeTurnContext } from '../../claude-turn-context';
import type { validateToolPermission } from '../../streaming/pending-permission/validate-tool-permission';
import { buildClaudeSessionCallbacks } from './session-callbacks';

type Verdict = Awaited<ReturnType<typeof validateToolPermission>>;

const ASKED = 'A hook asked to confirm this call, which Frink cannot prompt for yet.';
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
  const callbacks = buildClaudeSessionCallbacks(scope, session);
  const run = callbacks.hooks.PreToolUse[0].hooks[0];
  return {
    turn,
    validate,
    run: (input: PreToolUseHookInput, during = signal) => run(input, 'tool-1', { signal: during }),
    canUseTool: callbacks.canUseTool,
  };
}

const bash = toolCall('Bash', { command: 'ls' });
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
    const stop = { continue: false, stopReason: 'halt' };
    const { run } = gate([prints({ ...pre({ updatedInput: { todos: [] } }), ...stop })], allowRule);
    expect(await run(toolCall('TodoWrite', {}))).toEqual({
      ...pre({ updatedInput: { todos: [] } }),
      ...stop,
    });
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

  it('refuses a call a hook asks to confirm, because no prompt can be shown for it yet', async () => {
    const asks = pre({ permissionDecision: 'ask', permissionDecisionReason: 'check this' });
    const { run, validate } = gate([prints(asks)], allowRule);
    expect((await run(bash)).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: `${ASKED} Its reason: check this`,
    });
    expect(validate).not.toHaveBeenCalled();
  });
});

// What the bundled CLI sends once Auto's classifier stops classifying after repeated blocks.
const GAVE_UP_IN_A_ROW =
  '3 consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: The server-side auto mode classifier judged this action dangerous (it gave no explanation)';
const GAVE_UP_THIS_SESSION =
  '20 actions were blocked this session. Please review the transcript before continuing.';
const USER_DENIED: Verdict = { allowed: false, message: 'User denied permission' };
const asked = (decisionReason?: string) => ({
  signal,
  toolUseID: 'tool-1',
  requestId: 'request-1',
  decisionReason,
});

/** An Auto turn whose rules leave the call to Auto review, and whose card the user refuses. */
function autoGate({ flow = false, rules }: { flow?: boolean; rules?: () => Verdict } = {}) {
  const auto = gate(undefined, rules ?? (() => USER_DENIED));
  auto.turn.autoReviewTools = true;
  auto.turn.execution.isFlowTurn = flow;
  if (!rules) {
    auto.validate.mockImplementation(async (...args) =>
      args[8] ? { allowed: null } : USER_DENIED,
    );
  }
  return auto;
}

describe('a call Claude Auto review gave up on', () => {
  it.each([
    ['blocked in a row', GAVE_UP_IN_A_ROW],
    ['blocked across the session', GAVE_UP_THIS_SESSION],
  ])('goes to the permission card, never a blanket allow (%s)', async (_, reason) => {
    const { canUseTool, validate } = autoGate();
    expect(await canUseTool('Bash', { command: 'ls' }, asked(reason))).toEqual({
      behavior: 'deny',
      message: 'User denied permission',
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0].slice(7, 10)).toEqual([false, false, signal]);
  });

  it('goes to the card for an MCP call too, instead of allowing the undecided residual', async () => {
    const { canUseTool, validate } = autoGate();
    const call = await canUseTool('mcp__shortcut__stories-update', {}, asked(GAVE_UP_IN_A_ROW));
    expect(call).toEqual({ behavior: 'deny', message: 'User denied permission' });
    expect(validate.mock.calls[0][8]).toBe(false);
  });

  it("runs a call the user's own rules already allow, with no card", async () => {
    const { canUseTool } = autoGate({ rules: allowRule });
    expect(await canUseTool('Bash', { command: 'ls' }, asked(GAVE_UP_IN_A_ROW))).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
  });

  it('is refused on a flow turn, saying how to park, without opening a card', async () => {
    const { canUseTool, validate } = autoGate({ flow: true });
    const call = await canUseTool('Bash', { command: 'ls' }, asked(GAVE_UP_IN_A_ROW));
    expect(call).toMatchObject({ behavior: 'deny' });
    expect(call?.behavior === 'deny' && call.message).toContain('frink_task_signal');
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps Frink's other checks after the user approves it on the card", async () => {
    const { canUseTool, validate } = autoGate({ rules: allowRule });
    const call = await canUseTool('mcp__shortcut__stories-update', {}, asked(GAVE_UP_IN_A_ROW));
    expect(call).toEqual({ behavior: 'allow', updatedInput: {} });
    // The card first, then the MCP rule re-check every call gets, rather than an outright allow.
    expect(validate.mock.calls.map((args) => args[8])).toEqual([false, true]);
  });

  it('never refuses frink_task_signal, the way out its own refusal points the agent to', async () => {
    const { canUseTool, validate } = autoGate({ flow: true });
    const signalCall = { state: 'awaiting_input', summary: 'Approve this?' };
    const call = await canUseTool(
      'mcp__frink_dynamic_chat__frink_task_signal',
      signalCall,
      asked(GAVE_UP_IN_A_ROW),
    );
    expect(call).toEqual({ behavior: 'allow', updatedInput: signalCall });
    expect(validate.mock.calls.map((args) => args[8])).toEqual([true]);
  });

  it.each([...REQUIRED_TOOLS])(
    'never refuses %s, the agent machinery a plan or Flow step needs to finish',
    async (tool) => {
      const { canUseTool, validate, turn } = autoGate({ flow: true });
      turn.planAutoReview = true;
      expect(await canUseTool(tool, {}, asked(GAVE_UP_IN_A_ROW))).toEqual({
        behavior: 'allow',
        updatedInput: {},
      });
      expect(validate).not.toHaveBeenCalled();
    },
  );

  it('is refused without a card while an auto-reviewed plan is being drafted', async () => {
    const { canUseTool, validate, turn } = autoGate();
    turn.planAutoReview = true;
    const call = await canUseTool('Bash', { command: 'ls' }, asked(GAVE_UP_IN_A_ROW));
    expect(call).toMatchObject({ behavior: 'deny' });
    expect(validate).not.toHaveBeenCalled();
  });

  it('leaves any other call Auto review hands back allowed, as before', async () => {
    const { canUseTool, validate } = autoGate();
    expect(await canUseTool('Bash', { command: 'ls' }, asked('Bash wants to run ls'))).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it('changes nothing on a turn without Auto', async () => {
    const { canUseTool, validate, turn } = autoGate();
    turn.autoReviewTools = false;
    expect(await canUseTool('Bash', { command: 'ls' }, asked(GAVE_UP_IN_A_ROW))).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("an MCP call reaching Claude's permission callback", () => {
  const mcpCall = (rules: () => Verdict, tool = 'mcp__shortcut__stories-update') => {
    const { canUseTool, validate, turn } = gate(undefined, rules);
    return { validate, turn, ask: () => canUseTool(tool, {}, asked()) };
  };

  it('lets frink_register_node through without checking any rule', async () => {
    const { ask, validate } = mcpCall(allowRule, 'mcp__frink_dynamic_chat__frink_register_node');
    expect(await ask()).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(validate).not.toHaveBeenCalled();
  });

  it("re-checks the rules without a card, and follows a rule's answer", async () => {
    const allows = mcpCall(allowRule);
    expect(await allows.ask()).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(allows.validate.mock.calls[0][8]).toBe(true);
    expect(await mcpCall(() => USER_DENIED).ask()).toEqual({
      behavior: 'deny',
      message: 'User denied permission',
    });
  });

  it('allows a call no rule decides, except while an auto-reviewed plan is being drafted', async () => {
    const undecided = (): Verdict => ({ allowed: null });
    expect(await mcpCall(undecided).ask()).toEqual({ behavior: 'allow', updatedInput: {} });
    const planning = mcpCall(undecided);
    planning.turn.planAutoReview = true;
    planning.turn.autoReviewTools = true;
    expect(await planning.ask()).toEqual({
      behavior: 'deny',
      message: 'Provider review was not available',
    });
  });
});
