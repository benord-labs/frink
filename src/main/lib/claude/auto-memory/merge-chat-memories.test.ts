import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetChatMemoryMergeForTests, mergeChatMemoriesOnce } from './merge-chat-memories';

const SLUG = '-Users-dev-app';
let tmpRoot: string;
let sessions: string;
let projectMemory: string;

/** Write a chat's memory file (and its index line) with a given age in seconds. */
function chatMemory(chat: string, file: string, body: string, ageSeconds: number): string {
  const dir = path.join(sessions, chat, 'projects', SLUG, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, file);
  fs.writeFileSync(source, body);
  fs.appendFileSync(path.join(dir, 'MEMORY.md'), `- [${chat} ${file}](${file}) — hook\n`);
  const time = Date.now() / 1000 - ageSeconds;
  fs.utimesSync(source, time, time);
  return dir;
}

const read = (file: string) => fs.readFileSync(path.join(projectMemory, file), 'utf-8');

beforeEach(() => {
  _resetChatMemoryMergeForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-memory-merge-'));
  sessions = path.join(tmpRoot, 'claude-sessions');
  fs.mkdirSync(sessions);
  const home = path.join(tmpRoot, 'home');
  projectMemory = path.join(home, '.claude', 'projects', SLUG, 'memory');
  vi.stubEnv('FRINK_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('mergeChatMemoriesOnce', () => {
  it('copies per-chat memories into the project folder, newest same-name variant first', async () => {
    chatMemory('chat-a', 'testing.md', 'old', 60);
    chatMemory('chat-b', 'testing.md', 'new', 5);
    chatMemory('chat-a', 'style.md', 'style', 30);

    await mergeChatMemoriesOnce(sessions);

    expect(read('testing.md')).toBe('new');
    expect(read('style.md')).toBe('style');
    expect(read('MEMORY.md')).toBe(
      '- [chat-b testing.md](testing.md) — hook\n- [chat-a style.md](style.md) — hook\n',
    );
  });

  it('never overwrites a memory the project already has, nor duplicates its index line', async () => {
    fs.mkdirSync(projectMemory, { recursive: true });
    fs.writeFileSync(path.join(projectMemory, 'testing.md'), 'terminal');
    fs.writeFileSync(path.join(projectMemory, 'MEMORY.md'), '- [Testing](testing.md)');
    chatMemory('chat-a', 'testing.md', 'frink', 5);
    chatMemory('chat-a', 'new.md', 'fresh', 5);

    await mergeChatMemoriesOnce(sessions);

    expect(read('testing.md')).toBe('terminal');
    expect(read('MEMORY.md')).toBe('- [Testing](testing.md)\n- [chat-a new.md](new.md) — hook\n');
  });

  it('skips symlinked memory dirs, and creates nothing for chats without memories', async () => {
    const elsewhere = path.join(tmpRoot, 'other-project-memory');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'secret.md'), 'other project');
    const linked = path.join(sessions, 'chat-a', 'projects', SLUG);
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(linked, 'memory'), 'dir');
    fs.mkdirSync(path.join(sessions, 'chat-b', 'projects', '-tmp-scratch', 'memory'), {
      recursive: true,
    });

    await mergeChatMemoriesOnce(sessions);

    expect(fs.existsSync(path.join(tmpRoot, 'home', '.claude', 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(sessions, '.auto-memory-merged'))).toBe(true);
  });

  it('runs once: concurrent callers share a run, and the marker stops a later launch', async () => {
    chatMemory('chat-a', 'testing.md', 'frink', 5);
    await Promise.all([mergeChatMemoriesOnce(sessions), mergeChatMemoriesOnce(sessions)]);
    fs.rmSync(path.join(projectMemory, 'testing.md'));

    _resetChatMemoryMergeForTests();
    await mergeChatMemoriesOnce(sessions);

    expect(fs.existsSync(path.join(projectMemory, 'testing.md'))).toBe(false);
  });

  it('leaves no marker when a memory cannot be copied, so the next launch retries', async () => {
    chatMemory('chat-a', 'testing.md', 'frink', 5);
    fs.writeFileSync(path.join(tmpRoot, 'home'), 'a file where the home dir should be');

    await mergeChatMemoriesOnce(sessions);

    expect(fs.existsSync(path.join(sessions, '.auto-memory-merged'))).toBe(false);
  });

  it('reports a failed run and still resolves, so the chat spawns', async () => {
    const warn = vi.spyOn(log, 'warn');
    const notADir = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(notADir, '');

    await expect(mergeChatMemoriesOnce(notADir)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[auto-memory] per-chat merge failed:', expect.any(Error));
  });
});
