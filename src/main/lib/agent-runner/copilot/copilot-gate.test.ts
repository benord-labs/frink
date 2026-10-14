import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JsonValue } from '@github/copilot-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

  it('asks Read before opening an env file in the folder, in any letter case, but not .env.example', () => {
    const inFolder = (file: string) => read(path.join(cwd, file));
    for (const file of [
      '.env',
      '.ENV',
      '.env.local',
      'Prod.Env',
      'api/.env.local',
      'a/b/.Env.Production',
    ]) {
      expect(questions('view', { path: file })).toEqual(ask(inFolder(file)));
    }
    expect(questions('view', { path: path.join(cwd, 'api/.env') })).toEqual(
      ask(inFolder('api/.env')),
    );
    expect(questions('grep', { pattern: 'KEY', paths: '.env' })).toEqual(ask(inFolder('.env')));
    expect(questions('rg', { pattern: 'KEY', paths: ['src', 'api/.env.production'] })).toEqual(
      ask(inFolder('api/.env.production')),
    );
    for (const file of ['.env.example', 'api/.ENV.EXAMPLE', '.envrc', 'env.ts', 'environment.md']) {
      expect(questions('view', { path: file })).toEqual(ask());
    }
    expect(questions('rg', { pattern: 'KEY', paths: ['src', '.env.example'] })).toEqual(ask());
  });

  it('does not judge search or glob wildcards for env files, only paths that are one', () => {
    for (const glob of ['.env*', '*.env', '**/.env', 's*', 'config*', '*.production', '*']) {
      expect(questions('glob', { pattern: glob })).toEqual(ask());
      expect(questions('grep', { pattern: 'KEY', glob })).toEqual(ask());
      expect(questions('rg', { pattern: 'KEY', glob, paths: 'src' })).toEqual(ask());
    }
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

  it('asks about a header that follows a lone carriage return, as Copilot reads it', () => {
    const add = '*** Begin Patch\n*** Add File: a.txt\n+a\r*** Add File: /etc/b\n+b\n*** End Patch';
    const update =
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\r*** Add File: /etc/b\n+b\n*** End Patch';
    for (const patch of [add, update]) {
      expect(questions('apply_patch', patch)).toEqual(
        ask(edit(path.join(cwd, 'a.txt')), edit('/etc/b')),
      );
    }
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

type PlanFolder = Parameters<typeof createCopilotGate>[0]['plan'];

function testGate(answer: (request: CodexApprovalRequest) => ApprovalOutcome, plan?: PlanFolder) {
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
    plan,
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

describe("the session's own plan file", () => {
  let config = '';
  let elsewhere = '';
  let sessionId: string | undefined;
  const planOf = (id: string) => path.join(config, 'session-state', id, 'plan.md');
  const addPatch = (...files: string[]) =>
    `*** Begin Patch\n${files.map((file) => `*** Add File: ${file}\n+# Plan\n`).join('')}*** End Patch`;
  const planGate = () =>
    testGate(() => ALLOW, { configDirectory: config, sessionId: () => sessionId });

  /** The call is decided as it was before plan files were known: every question is asked. */
  async function judgedAsBefore(toolName: string, toolArgs: JsonValue) {
    const before = questions(toolName, toolArgs);
    const { asked, decide } = planGate();
    expect((await decide(toolName, toolArgs)).permissionDecision).toBe('allow');
    expect(before.kind).toBe('ask');
    expect(asked).toEqual('questions' in before ? before.questions : []);
  }

  beforeAll(async () => {
    // Not resolved: Copilot is given the folder as Frink names it, links above it included.
    config = await mkdtemp(path.join(os.tmpdir(), 'copilot config '));
    elsewhere = await mkdtemp(path.join(os.tmpdir(), 'copilot elsewhere '));
    for (const id of ['session-1', 'other']) {
      await mkdir(path.join(config, 'session-state', id), { recursive: true });
    }
    await mkdir(path.join(elsewhere, 'session-1'));
    await symlink(path.join(elsewhere, 'session-1'), path.join(config, 'session-state', 'linked'));
  });
  beforeEach(() => {
    sessionId = 'session-1';
  });
  afterEach(() => rm(planOf('session-1'), { force: true }));
  afterAll(async () => {
    await rm(config, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('lets Copilot write it without a question, by patch, create or edit', async () => {
    const { asked, decide } = planGate();
    const file = planOf('session-1');
    expect(await decide('apply_patch', addPatch(file))).toEqual({ permissionDecision: 'allow' });
    expect(await decide('create', { path: file, file_text: '# Plan' })).toEqual({
      permissionDecision: 'allow',
    });
    await writeFile(file, '# Plan\n');
    const update = `*** Begin Patch\n*** Update File: ${file}\n@@\n-# Plan\n+# Plan 2\n*** End Patch`;
    expect(await decide('apply_patch', update)).toEqual({ permissionDecision: 'allow' });
    expect(await decide('edit', { path: file, old_str: 'Plan', new_str: 'Plan 2' })).toEqual({
      permissionDecision: 'allow',
    });
    expect(asked).toEqual([]);
  });

  it('judges any other file in the folder, or a patch touching one more, as before', async () => {
    const file = planOf('session-1');
    await judgedAsBefore('create', { path: planOf('other'), file_text: 'x' });
    await judgedAsBefore('create', { path: path.join(path.dirname(file), 'events.jsonl') });
    await judgedAsBefore('create', { path: path.join(config, 'settings.json'), file_text: '{}' });
    await judgedAsBefore('apply_patch', addPatch(file, path.join(cwd, 'a.txt')));
    await judgedAsBefore('apply_patch', addPatch(file, planOf('other')));
    await judgedAsBefore(
      'apply_patch',
      `*** Begin Patch\n*** Update File: ${file}\n*** Move to: ${outside}\n*** End Patch`,
    );
    for (const plan of [`Add File: ${file}\n+# Plan`, `Update File: ${file}\n@@\n+# Plan 2`]) {
      const hidden = `*** ${plan}\r*** Add File: ${outside}\n+x`;
      await judgedAsBefore('apply_patch', `*** Begin Patch\n${hidden}\n*** End Patch`);
    }
    await judgedAsBefore('view', { path: file });
  });

  it('judges the plan named any other way as before', async () => {
    const file = planOf('session-1');
    const spellings = [
      path.relative(cwd, file),
      `${config}/session-state/session-1/../session-1/plan.md`,
      `${config}/session-state/./session-1/plan.md`,
      `${config}//session-state/session-1/plan.md`,
      `${file}/`,
      path.join(config, 'session-state', 'session-1', 'PLAN.md'),
      path.join(config, 'Session-State', 'session-1', 'plan.md'),
    ];
    for (const spelling of spellings) {
      await judgedAsBefore('create', { path: spelling, file_text: 'x' });
      await judgedAsBefore('apply_patch', addPatch(spelling));
    }
  });

  it('judges the plan as before when its folder or the file itself leads elsewhere', async () => {
    sessionId = 'linked';
    await judgedAsBefore('apply_patch', addPatch(planOf('linked')));

    sessionId = 'session-1';
    const target = path.join(elsewhere, 'target.md');
    await writeFile(target, 'keep');
    await symlink(target, planOf('session-1'));
    await judgedAsBefore('create', { path: planOf('session-1'), file_text: 'x' });
    await rm(planOf('session-1'));
    await link(target, planOf('session-1'));
    await judgedAsBefore('create', { path: planOf('session-1'), file_text: 'x' });
  });

  it('judges the plan as before when the session folder is a link', async () => {
    const linked = await mkdtemp(path.join(os.tmpdir(), 'copilot linked config '));
    await mkdir(path.join(elsewhere, 'state', 'session-1'), { recursive: true });
    await symlink(path.join(elsewhere, 'state'), path.join(linked, 'session-state'));
    const file = path.join(linked, 'session-state', 'session-1', 'plan.md');
    const { asked, decide } = testGate(() => ALLOW, {
      configDirectory: linked,
      sessionId: () => 'session-1',
    });
    expect((await decide('apply_patch', addPatch(file))).permissionDecision).toBe('allow');
    expect(asked).toEqual([edit(file)]);
    await rm(linked, { recursive: true, force: true });
  });

  it('judges a plan as before until a session is open, or for an id that is not a plain name', async () => {
    sessionId = undefined;
    await judgedAsBefore('apply_patch', addPatch(planOf('session-1')));
    sessionId = 'x/../session-1';
    await judgedAsBefore('apply_patch', addPatch(planOf('session-1')));
  });

  it('counts a plan write as allowed once, so a repeat it never saw trips the stop', async () => {
    const { gate, decide } = planGate();
    const patch = addPatch(planOf('session-1'));
    await decide('apply_patch', patch);
    gate.noteExecutionStart('a', 'apply_patch', patch);
    gate.noteExecutionStart('b', 'apply_patch', patch);
    expect(gate.actedUnasked('a', SUCCEEDED)).toBe(false);
    expect(gate.actedUnasked('b', SUCCEEDED)).toBe(true);
  });
});
