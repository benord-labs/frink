import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { startAcpAgentProcess } from './acp-process';
import { collectChunks, TEST_RULES, textOf } from './acp-test-fixtures';
import { disposeAllAcpAgents, runAcpAgent } from './index';

/** Real child processes, and a grace period before a force-stop, need more than the default. */
const PROCESS_TEST_TIMEOUT_MS = 20_000;
/** Starting a process, and the system reaping a stopped one, can take a while on a busy machine. */
const SETTLE = { timeout: 10_000 };

/** A real agent process on the SDK's agent side; `prompt` is the body of its prompt handler. */
function agentScript(prompt: string): string {
  return `
import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
const say = (sessionId, text) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});
agent({ name: 'child-agent' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 'child-session' }))
  .onRequest('session/prompt', async ({ params, client, requestId }) => { ${prompt} })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
setInterval(() => {}, 1000);
`;
}

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function launch(script: string) {
  return {
    command: process.execPath,
    args: ['--input-type=module', '--eval', script],
    cwd: process.cwd(),
    env: process.env,
    rules: TEST_RULES,
  };
}

function runTurn(script: string): Promise<UIMessageChunk[]> {
  const { cwd, ...agentLaunch } = launch(script);
  return collectChunks(
    runAcpAgent({
      launch: agentLaunch,
      agentId: 'child',
      agentName: 'Child Agent',
      cwd,
      prompt: 'hello',
      abortController: new AbortController(),
      checkApproval: async () => ({ allowed: false, message: 'not asked' }),
    }),
  );
}

describe('a turn against a real agent process', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  it('streams the reply and stops the process afterwards', async () => {
    const chunks = await runTurn(
      agentScript(`
        await client.notify('session/update', say(params.sessionId, 'pid ' + process.pid).params);
        return { stopReason: 'end_turn' };
      `),
    );

    const pid = Number(textOf(chunks).replace('pid ', ''));
    expect(pid).toBeGreaterThan(0);
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: { sessionId: 'child-session' },
    });
    await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false);
  });

  it('keeps text that arrives in the same write as the end of the turn', async () => {
    const chunks = await runTurn(
      agentScript(`
        const lines = ['one ', 'two ', 'three'].map((text) => say(params.sessionId, text));
        lines.push({ jsonrpc: '2.0', id: requestId, result: { stopReason: 'end_turn' } });
        process.stdout.write(lines.map((line) => JSON.stringify(line) + '\\n').join(''));
        await new Promise(() => {});
      `),
    );

    expect(textOf(chunks)).toBe('one two three');
    expect(chunks.map((chunk) => chunk.type).slice(-2)).toEqual(['text-end', 'finish']);
  });

  it('stops the process when its answer to the prompt cannot be read', async () => {
    const chunks = await runTurn(
      agentScript(`
        await client.notify('session/update', say(params.sessionId, 'pid ' + process.pid).params);
        return null;
      `),
    );

    const pid = Number(textOf(chunks).replace('pid ', ''));
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      { type: 'error', errorText: 'The agent sent a reply Frink could not read.' },
    ]);
    await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false);
  });

  it('says how the process ended when it exits in the middle of a turn', async () => {
    const chunks = await runTurn(
      agentScript(`process.stderr.write('not signed in'); process.exit(3);`),
    );

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([
      {
        type: 'error',
        errorText: 'The agent stopped unexpectedly (exited with code 3: not signed in).',
      },
    ]);
  });
});

describe('startAcpAgentProcess', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  it('stops a process that ignores its input closing, together with the child it started', async () => {
    const agent = startAcpAgentProcess(
      launch(`
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.stderr.write(String(child.pid));
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      `),
    );
    await expect.poll(() => agent.describeExit(), SETTLE).toMatch(/^\d+$/);
    const grandchild = Number(agent.describeExit());

    await agent.dispose();

    expect(agent.describeExit()).toContain('stopped by SIGKILL');
    await expect.poll(() => isAlive(grandchild), SETTLE).toBe(false);
  });

  it('force-stops at once, without a grace period, when given none', async () => {
    const agent = startAcpAgentProcess(
      launch(
        `process.on('SIGTERM', () => {}); process.stderr.write('ready'); setInterval(() => {}, 1000);`,
      ),
    );
    await expect.poll(() => agent.describeExit(), SETTLE).toBe('ready');
    const started = Date.now();

    await agent.dispose(0);

    expect(agent.describeExit()).toContain('stopped by SIGKILL');
    // Well under the grace period an ordinary stop gives the agent.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops a child that outlives an agent which has already exited', async () => {
    const agent = startAcpAgentProcess(
      launch(`
        import { spawn } from 'node:child_process';
        // The child names itself in one write, so its output can't interleave with the agent's.
        const ignoresStop = "process.on('SIGTERM', () => {}); process.stderr.write('ready ' + process.pid); setInterval(() => {}, 1000)";
        spawn(process.execPath, ['--eval', ignoresStop], { stdio: ['ignore', 'ignore', 'inherit'] });
        process.exit(0);
      `),
    );
    await expect
      .poll(() => agent.describeExit(), SETTLE)
      .toMatch(/^exited with code 0: ready \d+$/);
    const survivor = Number(agent.describeExit().match(/(?<=ready )\d+/)?.[0]);
    expect(isAlive(survivor)).toBe(true);

    await agent.dispose();

    await expect.poll(() => isAlive(survivor), SETTLE).toBe(false);
  });

  it('describes an agent that exits with a long error by the last line of it alone', async () => {
    const lastLine = 'x'.repeat(300);
    const agent = startAcpAgentProcess(
      launch(
        `process.stderr.write('stack line\\n'.repeat(180) + '${lastLine}\\n'); process.exit(3);`,
      ),
    );
    await agent.closed;
    expect(agent.describeExit()).toBe(`exited with code 3: ${'x'.repeat(200)}`);
    await agent.dispose();
  });

  it('describes an agent that exits by itself with its exit code and error output', async () => {
    const agent = startAcpAgentProcess(
      launch(`process.stderr.write('not signed in'); process.exit(3);`),
    );
    await agent.closed;
    expect(agent.describeExit()).toBe('exited with code 3: not signed in');
    await agent.dispose();
  });

  it('describes a command that cannot be started', async () => {
    const agent = startAcpAgentProcess({ ...launch(''), command: '/nonexistent/acp-agent' });
    await agent.closed;
    expect(agent.describeExit()).toContain('could not start');
    await agent.dispose();
  });
});

describe('disposeAllAcpAgents', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  it('stops every agent still running, together with the children they started', async () => {
    const agent = startAcpAgentProcess(
      launch(`
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.stderr.write(String(child.pid));
        setInterval(() => {}, 1000);
      `),
    );
    await expect.poll(() => agent.describeExit(), SETTLE).toMatch(/^\d+$/);
    const grandchild = Number(agent.describeExit());

    await disposeAllAcpAgents();

    expect(agent.describeExit()).toMatch(/^stopped by SIG/);
    await expect.poll(() => isAlive(grandchild), SETTLE).toBe(false);
  });

  it('returns at once when no agent is running', async () => {
    const first = await Promise.race([
      disposeAllAcpAgents().then(() => 'returned'),
      delay(0, 'waited'),
    ]);

    expect(first).toBe('returned');
  });
});

describe('loading the protocol library', () => {
  it('happens only when a turn starts, never on importing the runner', () => {
    const folder = import.meta.dirname;
    const sources = readdirSync(folder).filter(
      (file) => file.endsWith('.ts') && !file.includes('test'),
    );

    for (const file of sources) {
      const source = readFileSync(path.join(folder, file), 'utf8');
      // Compiled as the app bundle compiles it: imports used only as types disappear.
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText;
      expect(compiled, file).not.toMatch(/from ['"]@agentclientprotocol\/sdk['"]/);
    }
    expect(sources).toContain('acp-runner.ts');
  });
});
