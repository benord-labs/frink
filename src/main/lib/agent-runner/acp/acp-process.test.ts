import { describe, expect, it } from 'vitest';
import { startAcpAgentProcess } from './index';

/** Real child processes, and a grace period before a force-stop, need more than the default. */
const PROCESS_TEST_TIMEOUT_MS = 20_000;
/** Starting a process, and the system reaping a stopped one, can take a while on a busy machine. */
const SETTLE = { timeout: 10_000 };

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
  };
}

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

  it('stops a child that outlives an agent which has already exited', async () => {
    const agent = startAcpAgentProcess(
      launch(`
        import { spawn } from 'node:child_process';
        const ignoresStop = "process.on('SIGTERM', () => {}); process.stderr.write(' ready'); setInterval(() => {}, 1000)";
        const child = spawn(process.execPath, ['--eval', ignoresStop], { stdio: ['ignore', 'ignore', 'inherit'] });
        process.stderr.write(String(child.pid));
        process.exit(0);
      `),
    );
    await expect
      .poll(() => agent.describeExit(), SETTLE)
      .toMatch(/^exited with code 0: \d+ ready$/);
    const survivor = Number(agent.describeExit().match(/\d+(?= ready)/)?.[0]);
    expect(isAlive(survivor)).toBe(true);

    await agent.dispose();

    await expect.poll(() => isAlive(survivor), SETTLE).toBe(false);
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
