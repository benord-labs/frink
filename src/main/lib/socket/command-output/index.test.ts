import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holds = vi.hoisted(() => new Map<string, unknown>());
const codexTurns = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../claude-wake-hold', () => ({ readWakeHolds: () => holds }));
vi.mock('../../agent-runner/codex/codex-live-turn', () => ({
  getCodexLiveTurn: (subChatId: string) => codexTurns.get(subChatId),
}));

import { cleanOutputTail, readCommandOutput } from '.';

const SESSION = 'a3ef8c94-3334-43aa-95dd-e82c1b57c343';
let tmp: string;
let tasksDir: string;

function holdWith(tasks: { id: string; type: string }[], sdkSessionId = SESSION) {
  holds.set('sc1', {
    session: { sdkSessionId, stopHook: { lastPendingWork: { backgroundTasks: tasks } } },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'command-output-'));
  vi.stubEnv('CLAUDE_CODE_TMPDIR', tmp);
  const root = join(tmp, `claude-${process.getuid?.() ?? 0}`);
  // An unrelated project first, so the lookup has to search rather than take the only entry.
  mkdirSync(join(root, '-other-project'), { recursive: true });
  tasksDir = join(root, '-Users-me-project', SESSION, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  holds.clear();
  codexTurns.clear();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('readCommandOutput', () => {
  it('reads a held shell’s output from the CLI’s task file', async () => {
    writeFileSync(join(tasksDir, 'b1.output'), 'tick 1\ntick 2\n');
    holdWith([{ id: 'b1', type: 'shell' }]);

    const tail = await readCommandOutput('sc1', 'b1');

    expect(tail?.text).toBe('tick 1\ntick 2');
    expect(tail?.runningForMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps only the last 8KB, starting on a whole line', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    writeFileSync(join(tasksDir, 'b1.output'), `${lines.join('\n')}\n`);
    holdWith([{ id: 'b1', type: 'shell' }]);

    const text = (await readCommandOutput('sc1', 'b1'))?.text ?? '';

    expect(text.length).toBeLessThanOrEqual(8192);
    expect(text.endsWith('line 1999')).toBe(true);
    expect(lines).toContain(text.split('\n')[0]);
  });

  it('has no details for anything but a shell the wait is still on', async () => {
    writeFileSync(join(tasksDir, 'a1.output'), 'agent transcript');
    holdWith([{ id: 'a1', type: 'subagent' }]);

    expect(await readCommandOutput('sc1', 'a1')).toBeNull();
    expect(await readCommandOutput('sc1', 'gone')).toBeNull();
    expect(await readCommandOutput('other-chat', 'a1')).toBeNull();
  });

  it('reports the output unavailable when the file cannot be found', async () => {
    holdWith([{ id: 'b1', type: 'shell' }]);

    expect(await readCommandOutput('sc1', 'b1')).toEqual({ runningForMs: null, text: null });
  });

  it('does not report a shell that ended while its output was being read', async () => {
    writeFileSync(join(tasksDir, 'b1.output'), 'done\n');
    let reads = 0;
    holds.set('sc1', {
      session: {
        sdkSessionId: SESSION,
        stopHook: {
          // The first look sees it running; by the time the read returns, the wait has moved on.
          get lastPendingWork() {
            reads += 1;
            return reads === 1 ? { backgroundTasks: [{ id: 'b1', type: 'shell' }] } : null;
          },
        },
      },
    });

    expect(await readCommandOutput('sc1', 'b1')).toBeNull();
  });

  it('looks again for a missing file only after a pause, and only for that task', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeFileSync(join(tasksDir, 'b2.output'), 'sibling');
    holdWith([
      { id: 'b1', type: 'shell' },
      { id: 'b2', type: 'shell' },
    ]);

    expect(await readCommandOutput('sc1', 'b1')).toEqual({ runningForMs: null, text: null });
    // A sibling whose file exists is unaffected by the miss.
    expect((await readCommandOutput('sc1', 'b2'))?.text).toBe('sibling');

    writeFileSync(join(tasksDir, 'b1.output'), 'started late');
    expect((await readCommandOutput('sc1', 'b1'))?.text).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect((await readCommandOutput('sc1', 'b1'))?.text).toBe('started late');
    vi.useRealTimers();
  });

  it('never follows a symlink planted in place of the task file', async () => {
    const secret = join(tmp, 'secret');
    writeFileSync(secret, 'do not show');
    symlinkSync(secret, join(tasksDir, 'b1.output'));
    holdWith([{ id: 'b1', type: 'shell' }]);

    expect(await readCommandOutput('sc1', 'b1')).toEqual({ runningForMs: null, text: null });
  });

  it('refuses ids that could step outside the tasks dir', async () => {
    writeFileSync(join(tmp, 'escape.output'), 'outside');
    holdWith([{ id: '../../../../escape', type: 'shell' }], '..');

    expect(await readCommandOutput('sc1', '../../../../escape')).toEqual({
      runningForMs: null,
      text: null,
    });
  });
});

describe('readCommandOutput on a Codex chat', () => {
  it('reads a running command’s output from its live turn', async () => {
    const startedAt = Date.now() - 5000;
    codexTurns.set('sc1', {
      commandOutputs: new Map([['c1', { startedAt, text: 'ial\n\u001b[1mbuilt\u001b[0m\n', cut: true }]]),
    });

    const tail = await readCommandOutput('sc1', 'c1');

    expect(tail?.text).toBe('built');
    expect(tail?.runningForMs).toBeGreaterThanOrEqual(5000);
  });

  it('marks a Codex command’s single overlong line as cut', async () => {
    codexTurns.set('sc1', {
      commandOutputs: new Map([['c1', { startedAt: Date.now(), text: 'x'.repeat(8192), cut: true }]]),
    });

    expect((await readCommandOutput('sc1', 'c1'))?.text).toBe(`…${'x'.repeat(8191)}`);
  });

  it('has nothing for a command the live turn is not running', async () => {
    codexTurns.set('sc1', { commandOutputs: new Map() });

    expect(await readCommandOutput('sc1', 'c1')).toBeNull();
  });
});

describe('cleanOutputTail', () => {
  it('strips colours and keeps a redrawn progress line’s last state', () => {
    expect(cleanOutputTail('\u001b[32mPASS\u001b[0m a.test\r\n 10%\r 50%\r100%\ndone\n', false)).toBe(
      'PASS a.test\n100%\ndone',
    );
  });

  it('drops the partial line a cut tail opens with', () => {
    expect(cleanOutputTail('ial line\nwhole line', true)).toBe('whole line');
  });

  it('marks, rather than drops, a cut tail that is all one long line', () => {
    expect(cleanOutputTail('xprogress 99%', true)).toBe('…progress 99%');
  });

  it('does not render binary output', () => {
    expect(cleanOutputTail('PNG\u0000\u0001', false)).toBe('Binary output');
  });
});
