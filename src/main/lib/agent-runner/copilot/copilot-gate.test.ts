import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JsonValue } from '@github/copilot-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexApprovalCheck } from '../codex/codex-approvals';
import type { ApprovalOutcome, CodexApprovalRequest } from '../codex/codex-events';
import {
  type PreToolUseHookInput,
  type PreToolUseHookOutput,
  questionsForCopilotTool,
} from './copilot-gate';
import { COPILOT_TOOLS, createCopilotGate } from './index';

let cwd = '';
const outside = path.join(os.tmpdir(), 'copilot gate outside', 'notes.txt');
const CANT_CHECK = "Frink can't check this tool yet, so it didn't run.";

beforeAll(async () => {
  // A space in the path, as in macOS's Application Support folder.
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'copilot gate ')));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function questions(toolName: string, toolArgs: JsonValue) {
  return questionsForCopilotTool(toolName, toolArgs, cwd, COPILOT_TOOLS);
}

const ask = (...asked: CodexApprovalRequest[]) => ({ kind: 'ask', questions: asked });
const bash = (command: string) => ({ toolName: 'Bash', input: { command } });
const edit = (file: string) => ({ toolName: 'Edit', input: { file_path: file } });
const read = (file: string) => ({ toolName: 'Read', input: { file_path: file } });

describe('questionsForCopilotTool', () => {
  it('asks each tool the question its rule names, from calls the agent made', () => {
    const file = path.join(cwd, 'm-create.txt');
    expect(questions('bash', { command: 'touch m.txt', description: 'write marker' })).toEqual(
      ask(bash('touch m.txt')),
    );
    expect(questions('bash', { command: 'ls', mode: 'async', detach: false })).toEqual(
      ask(bash('ls')),
    );
    expect(questions('create', { path: file, file_text: 'created' })).toEqual(ask(edit(file)));
    expect(questions('edit', { path: 'README.md', old_str: 'a', new_str: 'b' })).toEqual(
      ask(edit(path.join(cwd, 'README.md'))),
    );
    expect(questions('web_fetch', { url: 'https://example.com' })).toEqual(
      ask({ toolName: 'WebFetch', input: { url: 'https://example.com' } }),
    );
    expect(questions('web_search', { query: 'frink' })).toEqual(
      ask({ toolName: 'WebSearch', input: { query: 'frink' } }),
    );
  });

  it('reads inside the folder without a question and asks Read for one outside it', () => {
    expect(questions('view', { path: path.join(cwd, 'README.md'), view_range: [1, 5] })).toEqual(
      ask(),
    );
    expect(questions('view', { path: outside })).toEqual(ask(read(outside)));
    expect(questions('glob', { pattern: '**/*.md' })).toEqual(ask());
    expect(questions('glob', { pattern: '/etc/*.conf' })).toEqual(ask(read('/etc')));
    expect(questions('glob', { pattern: '/**' })).toEqual(ask(read('/')));
    expect(questions('glob', { pattern: '../../**' })).toEqual(
      ask(read(path.resolve(cwd, '../..'))),
    );
    expect(questions('glob', { pattern: '*.conf', paths: '/etc' })).toEqual(ask(read('/etc')));
    expect(questions('glob', { pattern: '/etc/*', paths: [] })).toEqual(ask(read('/etc')));
    expect(questions('glob', { pattern: 'src/**/*.{ts,tsx}' })).toEqual(ask());
    expect(questions('grep', { pattern: 'localhost', paths: '/etc' })).toEqual(ask(read('/etc')));
    expect(questions('rg', { pattern: 'x', paths: [cwd, '/etc', outside] })).toEqual(
      ask(read('/etc'), read(outside)),
    );
  });

  it('lets quiet tools through with no question', () => {
    expect(questions('sql', { description: 'todo', query: 'select 1' })).toEqual({ kind: 'quiet' });
    expect(
      questions('task', {
        name: 'look',
        description: 'look',
        prompt: 'run ls',
        agent_type: 'explore',
        mode: 'sync',
      }),
    ).toEqual({ kind: 'quiet' });
  });

  it('asks one Edit for every file a patch names', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '*** Update File: README.md',
      '*** Move to: docs/README.md',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    expect(questions('apply_patch', patch)).toEqual(
      ask(
        edit(path.join(cwd, 'new.txt')),
        edit(path.join(cwd, 'README.md')),
        edit(path.join(cwd, 'docs/README.md')),
      ),
    );
  });

  it.each([' ', '\t'])('asks about a patch header indented by %j', (indent) => {
    const patch = `*** Begin Patch\n*** Add File: a.txt\n+a\n${indent}*** Add File: /etc/b\n+b\n*** End Patch`;
    expect(questions('apply_patch', patch)).toEqual(
      ask(edit(path.join(cwd, 'a.txt')), edit('/etc/b')),
    );
  });

  it.each([
    ['an unknown tool', 'lsp', { operation: 'hover', file: 'README.md' }],
    ['a name inherited from Object', 'toString', {}],
    ['an unknown key', 'view', { path: 'README.md', follow: true }],
    ['a reused shell', 'bash', { command: 'pwd', shellId: '1' }],
    ['a detached shell', 'bash', { command: 'sleep 9', mode: 'async', detach: true }],
    ['a read under ~', 'view', { path: '~/.ssh/config' }],
    ['an edit under ~', 'create', { path: '~/notes.txt', file_text: 'x' }],
    ['a patch under ~', 'apply_patch', '*** Begin Patch\n*** Add File: ~/a.txt\n+x\n*** End Patch'],
    ['a patch path after two spaces', 'apply_patch', '*** Begin Patch\n*** Add File:  /etc/b\n'],
    ['a glob under ~', 'glob', { pattern: '~/**' }],
    ['a glob that steps up after a wildcard', 'glob', { pattern: 'src/*/../../../etc/*' }],
    ['a glob whose braces start at /', 'glob', { pattern: '{/etc,x}/*.conf' }],
    ['a glob whose group names a folder under ~', 'glob', { pattern: '@(x|~/y)/*' }],
    ['a glob that steps up inside a group', 'glob', { pattern: '@(a|..)/x' }],
    ['a glob spelling .. with ?', 'glob', { pattern: '??/etc/*' }],
    ['a glob spelling .. with classes', 'glob', { pattern: '[.][.]/etc/*' }],
    ['a glob spelling .. with braces', 'glob', { pattern: '{.,.}{.,.}/etc/*' }],
    ['a glob with / in a nested group', 'glob', { pattern: 'src/{x,{/etc,y}}/*' }],
    ['a call with nothing to ask about', 'bash', { description: 'empty' }],
    ['a blank command', 'bash', { command: '  ' }],
    ['an agent type outside the list', 'task', { prompt: 'x', agent_type: 'evil' }],
    ['a background task', 'task', { prompt: 'x', agent_type: 'explore', mode: 'background' }],
    ['a task that does not say it waits', 'task', { prompt: 'x', agent_type: 'explore' }],
    ['a glob with a backslash', 'glob', { pattern: 'C:\\Users\\*' }],
    ['input that is not an object', 'bash', 'touch m.txt'],
    ['a patch with no file', 'apply_patch', '*** Begin Patch\n*** End Patch'],
    ['a patch with an unknown header', 'apply_patch', '*** Begin Patch\n*** Chmod File: a\n'],
    ['a patch without its opening line', 'apply_patch', '*** Add File: a.txt\n+x'],
    ['a patch given as an object', 'apply_patch', { input: '*** Begin Patch' }],
  ])('refuses %s', (_name, toolName, toolArgs) => {
    expect(questions(toolName, toolArgs)).toEqual({ kind: 'refuse', reason: CANT_CHECK });
  });
});

function hookInput(toolName: string, toolArgs: JsonValue): PreToolUseHookInput {
  return { sessionId: 's1', timestamp: new Date(0), workingDirectory: cwd, toolName, toolArgs };
}

function testGate(answer: (request: CodexApprovalRequest) => ApprovalOutcome) {
  const asked: CodexApprovalRequest[] = [];
  const turn = new AbortController();
  const checkApproval: CodexApprovalCheck = async (request) => {
    asked.push(request);
    return answer(request);
  };
  const gate = createCopilotGate({
    cwd,
    tools: COPILOT_TOOLS,
    checkApproval,
    turnOver: turn.signal,
  });
  const decide = (toolName: string, toolArgs: JsonValue): Promise<PreToolUseHookOutput> =>
    gate.onPreToolUse(hookInput(toolName, toolArgs));
  return { gate, asked, turn, decide };
}

const ALLOW: ApprovalOutcome = { allowed: true };
const DENIED: ApprovalOutcome = { allowed: false, message: 'User denied permission' };

describe('createCopilotGate', () => {
  it('allows a call whose every question is allowed and asks nothing more', async () => {
    const { asked, decide } = testGate(() => ALLOW);
    const patch =
      '*** Begin Patch\n*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b\n*** End Patch';
    expect(await decide('apply_patch', patch)).toEqual({ permissionDecision: 'allow' });
    expect(asked).toEqual([edit(path.join(cwd, 'a.txt')), edit(path.join(cwd, 'b.txt'))]);
  });

  it('denies with the gate message when one question is refused', async () => {
    const { decide } = testGate((request) =>
      request.input.file_path === path.join(cwd, 'b.txt') ? DENIED : ALLOW,
    );
    const patch =
      '*** Begin Patch\n*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b\n*** End Patch';
    expect(await decide('apply_patch', patch)).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'User denied permission',
    });
  });

  it('denies a call no rule or person decided', async () => {
    const { decide } = testGate(() => ({ allowed: null }));
    expect((await decide('bash', { command: 'ls' })).permissionDecision).toBe('deny');
  });

  it('allows quiet tools and reads inside the folder without asking', async () => {
    const { asked, decide } = testGate(() => DENIED);
    expect(await decide('sql', { description: 'd', query: 'select 1' })).toEqual({
      permissionDecision: 'allow',
    });
    expect(await decide('view', { path: 'README.md' })).toEqual({ permissionDecision: 'allow' });
    expect(asked).toEqual([]);
  });

  it('refuses a call it cannot describe, and says why', async () => {
    const { asked, decide } = testGate(() => ALLOW);
    expect(await decide('lsp', { operation: 'hover' })).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: CANT_CHECK,
    });
    expect(asked).toEqual([]);
  });

  it('refuses a call with a key the parse would drop', async () => {
    const { asked, decide } = testGate(() => ALLOW);
    const args = JSON.parse('{"command":"ls","__proto__":{"shellId":"7"}}');
    expect(await decide('bash', args)).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: CANT_CHECK,
    });
    expect(asked).toEqual([]);
  });

  it('denies when checking throws', async () => {
    const { decide } = testGate(() => {
      throw new Error('store closed');
    });
    expect((await decide('bash', { command: 'ls' })).permissionDecision).toBe('deny');
  });

  it('denies every call once the turn is over, even one asked before it ended', async () => {
    const ended = testGate(() => ALLOW);
    ended.turn.abort();
    expect((await ended.decide('sql', { description: 'd', query: 'x' })).permissionDecision).toBe(
      'deny',
    );
    expect(ended.asked).toEqual([]);

    const late = testGate(() => {
      late.turn.abort();
      return ALLOW;
    });
    expect((await late.decide('bash', { command: 'ls' })).permissionDecision).toBe('deny');
  });
});

// How Copilot reports finished calls, as recorded from the CLI.
const SUCCEEDED = {};
const FAILED = { error: { code: 'failure', message: 'exit 1' } };
const REFUSED = { error: { code: 'denied', message: 'Denied by preToolUse hook: no' } };

describe('the stop on an unasked action', () => {
  it('does not trip when a parent and a child run the same command and one was denied', async () => {
    let answers = [ALLOW, DENIED];
    const { gate, decide } = testGate(() => {
      const [next, ...rest] = answers;
      answers = rest;
      return next ?? DENIED;
    });
    expect((await decide('bash', { command: 'ls' })).permissionDecision).toBe('allow');
    expect((await decide('bash', { command: 'ls' })).permissionDecision).toBe('deny');
    gate.noteExecutionStart('child', 'bash', { command: 'ls' });
    gate.noteExecutionStart('parent', 'bash', { command: 'ls' });
    expect(gate.actedUnasked('child', REFUSED)).toBe(false);
    expect(gate.actedUnasked('parent', SUCCEEDED)).toBe(false);
  });

  it('trips on a successful call that was never allowed, or allowed once and run twice', async () => {
    const { gate, decide } = testGate(() => ALLOW);
    gate.noteExecutionStart('a', 'bash', { command: 'touch m.txt' });
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(true);
    await decide('bash', { command: 'ls', description: 'list' });
    gate.noteExecutionStart('b', 'bash', { description: 'list', command: 'ls' });
    gate.noteExecutionStart('c', 'bash', { description: 'list', command: 'ls' });
    expect(gate.actedUnasked('b', SUCCEEDED)).toBe(false);
    expect(gate.actedUnasked('c', SUCCEEDED)).toBe(true);
  });

  it('trips when the call that ran differs from the one allowed', async () => {
    const { gate, decide } = testGate(() => ALLOW);
    await decide('bash', { command: 'ls' });
    gate.noteExecutionStart('a', 'bash', { command: 'ls; touch m.txt' });
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(true);
  });

  it('counts an in-folder read as allowed and never trips on a quiet tool', async () => {
    const { gate, decide } = testGate(() => DENIED);
    await decide('view', { path: 'README.md' });
    gate.noteExecutionStart('a', 'view', { path: 'README.md' });
    gate.noteExecutionStart('b', 'sql', { description: 'd', query: 'select 1' });
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(false);
    expect(gate.actedUnasked('b', SUCCEEDED)).toBe(false);
  });

  it('trips on a repeat of an allowed call that failed', async () => {
    const { gate, decide } = testGate(() => ALLOW);
    await decide('bash', { command: 'ls' });
    gate.noteExecutionStart('a', 'bash', { command: 'ls' });
    expect(gate.actedUnasked('a', FAILED)).toBe(false);
    gate.noteExecutionStart('b', 'bash', { command: 'ls' });
    expect(gate.actedUnasked('b', SUCCEEDED)).toBe(true);
  });

  it('trips on a refused call that ran anyway, even when it failed', async () => {
    const { gate, decide } = testGate(() => DENIED);
    await decide('bash', { command: 'make x' });
    gate.noteExecutionStart('a', 'bash', { command: 'make x' });
    expect(gate.actedUnasked('a', FAILED)).toBe(true);
  });

  it('trips on a refused copy that succeeded after its allowed twin failed', async () => {
    let answers = [ALLOW, DENIED];
    const { gate, decide } = testGate(() => {
      const [next, ...rest] = answers;
      answers = rest;
      return next ?? DENIED;
    });
    await decide('bash', { command: 'ls' });
    await decide('bash', { command: 'ls' });
    gate.noteExecutionStart('allowed', 'bash', { command: 'ls' });
    gate.noteExecutionStart('refused', 'bash', { command: 'ls' });
    expect(gate.actedUnasked('allowed', FAILED)).toBe(false);
    expect(gate.actedUnasked('refused', SUCCEEDED)).toBe(true);
  });

  it('trips on a refused call to a quiet tool that ran anyway', async () => {
    const { gate, decide } = testGate(() => ALLOW);
    const background = { prompt: 'x', agent_type: 'explore', mode: 'background' };
    expect((await decide('task', background)).permissionDecision).toBe('deny');
    gate.noteExecutionStart('a', 'task', background);
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(true);
  });

  it('trips on a tool it does not know and on a finish it never saw start', () => {
    const { gate } = testGate(() => ALLOW);
    gate.noteExecutionStart('a', 'lsp', { operation: 'hover' });
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(true);
    expect(gate.actedUnasked('unseen', SUCCEEDED)).toBe(true);
  });
});
