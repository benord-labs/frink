import { chmod, lstat, stat } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../../shared/types/permissions';
import { gateParent } from './cursor-gate-socket';
import { openGateSocket } from './index';

type Gate = Awaited<ReturnType<typeof openGateSocket>>;

const DENY = {
  permission: 'deny',
  user_message: "Frink couldn't read Cursor's request, so it blocked it.",
};

/** Posts one hook body over the socket, as the wrapper's curl does, and returns the reply text. */
function post(socketPath: string, body: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: 'POST', path: '/hook' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('openGateSocket', () => {
  const gates: Gate[] = [];
  const open = async (answer: (body: string) => Promise<JsonValue>) => {
    const gate = await openGateSocket(answer);
    gates.push(gate);
    return gate;
  };
  afterEach(async () => {
    await Promise.all(gates.splice(0).map((gate) => gate.close()));
  });

  it('answers each hook call with what the answer function returns', async () => {
    const gate = await open(async (body) => ({ permission: 'allow', echo: body }));
    const sent = '{"hook_event_name":"preToolUse","__proto__":{}}';
    const reply = await post(gate.socketPath, sent);
    expect(JSON.parse(reply)).toEqual({ permission: 'allow', echo: sent });
  });

  it('listens in a fresh folder only the user can open', async () => {
    const gate = await open(async () => ({ continue: true }));
    expect(path.basename(gate.gateDir)).toMatch(/^fcg-/);
    expect(gate.socketPath).toBe(path.join(gate.gateDir, 'g.sock'));
    expect((await stat(gate.gateDir)).mode & 0o777).toBe(0o700);
    const socket = await lstat(gate.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
  });

  it('denies a body over 1 MB and an answer that throws', async () => {
    const seen: string[] = [];
    const gate = await open(async (body) => {
      seen.push(body);
      throw new Error('gate failed');
    });
    const big = JSON.stringify({ text: 'a'.repeat(1024 * 1024) });
    expect(JSON.parse(await post(gate.socketPath, big))).toEqual(DENY);
    expect(seen).toEqual([]);
    expect(JSON.parse(await post(gate.socketPath, '{not json'))).toEqual(DENY);
    expect(seen).toEqual(['{not json']);
  });

  it('closes once, even with a hook call still waiting, and removes its folder', async () => {
    let reached = () => {};
    const waiting = new Promise<void>((resolve) => (reached = resolve));
    const gate = await open(() => {
      reached();
      return new Promise(() => {});
    });
    const pending = post(gate.socketPath, '{}').catch(() => 'closed');
    await waiting;
    await Promise.all([gate.close(), gate.close()]);
    await gate.close();
    expect(await pending).toBe('closed');
    await expect(lstat(gate.gateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes again after a close its folder refused', async () => {
    const gate = await open(async () => ({ continue: true }));
    await chmod(gate.gateDir, 0o500);
    await expect(gate.close()).rejects.toMatchObject({ code: 'EACCES' });
    await chmod(gate.gateDir, 0o700);
    await gate.close();
    await expect(lstat(gate.gateDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('gateParent', () => {
  const RUNTIME = '/run/user/1000';

  it('on Linux, uses the per-user runtime folder, as some systems mount /tmp so nothing runs from it', () => {
    expect(gateParent({ XDG_RUNTIME_DIR: RUNTIME }, 'linux')).toBe(RUNTIME);
    for (const runtime of [undefined, '', 'run/user/1000', '/run/user/my folder']) {
      expect(gateParent({ XDG_RUNTIME_DIR: runtime }, 'linux')).toBe(os.tmpdir());
    }
  });

  it('on macOS, keeps the temp folder', () => {
    expect(gateParent({ XDG_RUNTIME_DIR: RUNTIME }, 'darwin')).toBe(os.tmpdir());
  });

  it.runIf(process.platform === 'linux' && process.env.XDG_RUNTIME_DIR)(
    'on this Linux machine, listens in the runtime folder',
    async () => {
      const gate = await openGateSocket(async () => ({ continue: true }));
      try {
        expect(path.dirname(gate.gateDir)).toBe(process.env.XDG_RUNTIME_DIR);
      } finally {
        await gate.close();
      }
    },
  );
});
