import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandGateScript } from './acp-command-ledger';

const run = promisify(execFile);

describe('the shell gate script', () => {
  let root = '';
  let ledger = '';
  let gate = '';

  beforeEach(async () => {
    // A space in the path, as in macOS's Application Support folder.
    root = await mkdtemp(path.join(os.tmpdir(), 'acp gate '));
    ledger = path.join(root, 'ledger');
    gate = path.join(root, 'shell', 'sh');
    await mkdir(ledger);
    await mkdir(path.dirname(gate));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeGate(restore: Record<string, string | null> = {}) {
    await writeFile(gate, commandGateScript({ realShell: '/bin/sh', ledgerDir: ledger, restore }), {
      mode: 0o700,
    });
  }

  /** Runs the gate as an agent would; resolves to its exit code and output. */
  async function shell(args: string[], env: NodeJS.ProcessEnv = {}) {
    try {
      const { stdout } = await run(gate, args, {
        cwd: root,
        env: { PATH: process.env.PATH, ...env },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      // SAFETY: execFile rejects with the exit code and the output attached to its error.
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  it('runs a command Frink allowed once, then never again', async () => {
    await writeGate();
    await writeFile(path.join(ledger, 'a1'), 'printf ran');

    expect(await shell(['-c', 'printf ran'])).toMatchObject({ code: 0, stdout: 'ran' });
    expect(await readdir(ledger)).toEqual([]);
    expect((await shell(['-c', 'printf ran'])).code).toBe(126);
  });

  it('refuses a command Frink did not allow, and says why', async () => {
    await writeGate();
    await writeFile(path.join(ledger, 'a1'), 'printf ran');

    expect(await shell(['-c', '> outside.txt'])).toEqual({
      code: 126,
      stdout: '',
      stderr: 'Frink did not approve this command, so it did not run.\n',
    });
    expect(await readdir(ledger)).toEqual(['a1']);
  });

  it('refuses any call that is not a single command', async () => {
    await writeGate();
    await writeFile(path.join(ledger, 'a1'), 'x');

    expect((await shell(['-l', '-c', 'x', 'opencode', 'cwd'])).code).toBe(126);
    expect((await shell(['-c', 'x', 'extra'])).code).toBe(126);
    expect((await shell([])).code).toBe(126);
    expect(await readdir(ledger)).toEqual(['a1']);
  });

  it('runs no program from the agent PATH while it checks a command', async () => {
    await writeGate();
    await writeFile(path.join(ledger, 'a1'), 'printf ran');
    const planted = path.join(root, 'bin');
    await mkdir(planted);
    for (const name of ['cat', 'mv', 'rm']) {
      await writeFile(path.join(planted, name), `#!/bin/sh\ntouch '${root}/planted'\n`, {
        mode: 0o700,
      });
    }
    const env = { PATH: `${planted}:/usr/bin:/bin` };

    expect((await shell(['-c', 'rm -rf x'], env)).code).toBe(126);
    expect(await shell(['-c', 'printf ran'], env)).toMatchObject({ code: 0, stdout: 'ran' });
    expect(await readdir(root)).not.toContain('planted');
  });

  it('runs an allowed command once when several shells ask for it at the same time', async () => {
    await writeGate();
    // Repeated, since a lost race shows only now and then.
    for (let round = 0; round < 20; round++) {
      await writeFile(path.join(ledger, 'a1'), 'printf ran');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => shell(['-c', 'printf ran'])),
      );

      expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    }
    expect(await readdir(ledger)).toEqual([]);
  });

  it('matches a command byte for byte, trailing newlines included', async () => {
    await writeGate();
    await writeFile(path.join(ledger, 'a1'), 'printf hi\n');

    expect((await shell(['-c', 'printf hi'])).code).toBe(126);
    expect(await shell(['-c', 'printf hi\n'])).toMatchObject({ code: 0, stdout: 'hi' });
  });

  it("sets back the user's own variables and removes Frink's before the command runs", async () => {
    await writeGate({ KEPT: "it's $HOME `x` !", FRINK_ONLY: null });
    const command = 'printf "%s|%s" "$KEPT" "${FRINK_ONLY-absent}"';
    await writeFile(path.join(ledger, 'a1'), command);

    const result = await shell(['-c', command], { KEPT: 'frink value', FRINK_ONLY: 'secret' });

    expect(result).toMatchObject({ code: 0, stdout: "it's $HOME `x` !|absent" });
  });
});
