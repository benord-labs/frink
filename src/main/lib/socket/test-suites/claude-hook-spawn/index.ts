import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getChatWithProjectAccount } from '../../../db/repos/chats';
import * as toolValidation from '../../../permissions/tool-validation';
import { frinkUserHome } from '../../../platform/frink-home';
import * as claudePlugin from '../../../provider/hooks/store/claude-plugin';
import { _resetHooksLockForTests } from '../../../provider/hooks/store/launch';
import * as pluginLock from '../../../provider/hooks/store/plugin-lock';
import { gitAsTestUser as git } from '../../../test-utils/git-as-test-user';
import { userPromptSubmitReminder } from '../../test-utils';
import { mockQuery } from '../claude-query-fake';
import { TURN_END } from '../claude-turn-bindings';
import { replies } from '../claude-warm-session';

type ClaudeQueryMock = ReturnType<typeof vi.fn>;
type Send = (message: string, overrides?: { subChatId?: string }) => Promise<void>;

/** A CLI that runs its UserPromptSubmit hook on each prompt it reads, then answers it. */
function promptHookCli(): Parameters<typeof mockQuery>[1] {
  return async function* ({ prompt, options }) {
    for (let n = 1; ; n += 1) {
      if ((await prompt.next()).done) return;
      await userPromptSubmitReminder({ options }, 'hi');
      yield { chunks: [{ type: 'text-delta', id: `t${n}`, delta: `reply ${n}` }] };
      yield* TURN_END;
    }
  };
}

/** One turn from a chat running in `cwd` (a new chat unless given); returns its CLI's spawn options. */
export async function sendFromChatIn(
  claudeQueryMock: ClaudeQueryMock,
  send: Send,
  cwd: string,
  subChatId: string = randomUUID(),
) {
  // SAFETY: the executor reads only the chat's worktreePath and taskId from this row.
  const row = { chat: { worktreePath: cwd, taskId: null }, account: null } as Awaited<
    ReturnType<typeof getChatWithProjectAccount>
  >;
  vi.mocked(getChatWithProjectAccount).mockResolvedValue(row);
  mockQuery(claudeQueryMock, promptHookCli());
  await send('hi', { subChatId });
  return claudeQueryMock.mock.calls.at(-1)?.[0]?.options;
}

const stopHook = (command: string) => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });
const LOCK_NOTICE = "Claude's own settings files";

/** A repo with a committed and a local hook, a worktree with its permissions elsewhere, a user hook.
 * The executor suite stubs `mkdirSync`, so folders are made through `fs.promises`. */
async function hookedRepoWithWorktree(tmpRoot: string) {
  const repo = path.join(tmpRoot, 'repo');
  git(tmpRoot, 'init', '-q', repo);
  await fs.promises.mkdir(path.join(repo, '.claude'));
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.json'),
    JSON.stringify({ hooks: stopHook('committed') }),
  );
  git(repo, 'add', '.claude/settings.json');
  git(repo, 'commit', '-q', '-m', 'init');
  const worktree = path.join(tmpRoot, 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', worktree);
  // Uncommitted, so only the main checkout has it.
  fs.writeFileSync(
    path.join(repo, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: stopHook('local') }),
  );
  const permissions = path.join(tmpRoot, 'permissions');
  vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation((p) =>
    p === worktree ? permissions : p,
  );
  const userFile = path.join(frinkUserHome(), '.claude', 'settings.json');
  await fs.promises.mkdir(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ hooks: stopHook('notify') }));
  return { worktree, userFile };
}

/** Runs one case on a hooked repo's worktree, the launch check finding the hook lock holding or not,
 * then removes the repo, restores the spies and resets the lock. */
async function inHookedWorktree(
  lockHolds: boolean,
  run: (tmpRoot: string, worktree: string) => Promise<void>,
) {
  const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-hooks-')));
  const { worktree, userFile } = await hookedRepoWithWorktree(tmpRoot);
  const spies = [
    vi.spyOn(pluginLock, 'pluginOnlyHooksHold').mockResolvedValue(lockHolds),
    vi.spyOn(pluginLock, 'cliRunsPluginOnlyHooks'),
    vi.spyOn(claudePlugin, 'claudeHooksPlugin').mockResolvedValue(path.join(tmpRoot, 'plugin')),
  ];
  try {
    await run(tmpRoot, worktree);
  } finally {
    for (const spy of spies) spy.mockRestore();
    _resetHooksLockForTests();
    fs.rmSync(userFile, { force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** A Claude chat's stored hooks reach its CLI once: as Frink's plugin under the plugin-only lock,
 * or, when a policy drops the lock, the user's alone through the flag settings, said in one line. */
export function registerClaudeHookSpawnTests(claudeQueryMock: ClaudeQueryMock, send: Send): void {
  it("a worktree chat spawns with the user's and the main checkout's hooks as one locked plugin", () =>
    inHookedWorktree(true, async (tmpRoot, worktree) => {
      const options = await sendFromChatIn(claudeQueryMock, send, worktree);

      const merged = ['notify', 'committed', 'local'].flatMap((command) => stopHook(command).Stop);
      expect(vi.mocked(claudePlugin.claudeHooksPlugin).mock.calls).toEqual([
        [{ Stop: merged }, options?.pathToClaudeCodeExecutable],
      ]);
      expect(options?.plugins).toEqual([{ type: 'local', path: path.join(tmpRoot, 'plugin') }]);
      expect(options?.managedSettings).toEqual({ strictPluginOnlyCustomization: ['hooks'] });
      expect(options?.settings).not.toHaveProperty('hooks');
      expect(options?.settings).not.toHaveProperty('disableAllHooks');
      expect(replies()).toEqual(['reply 1']);
    }));

  it('a CLI that reports a policy dropped the lock runs on; its chat leaves the lock at its next launch', () =>
    inHookedWorktree(true, async (_tmpRoot, worktree) => {
      let answer: (pluginOnly: boolean) => void = () => {};
      const answered = new Promise<boolean>((resolve) => {
        answer = resolve;
      });
      vi.mocked(pluginLock.cliRunsPluginOnlyHooks).mockReturnValueOnce(answered);
      const chat = randomUUID();

      const locked = await sendFromChatIn(claudeQueryMock, send, worktree, chat);
      answer(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(claudeQueryMock).toHaveBeenCalledOnce();
      const next = await sendFromChatIn(claudeQueryMock, send, worktree, chat);

      expect(pluginLock.cliRunsPluginOnlyHooks).toHaveBeenCalledOnce();
      expect(locked?.managedSettings).toEqual({ strictPluginOnlyCustomization: ['hooks'] });
      expect(next?.plugins).toBeUndefined();
      expect(next?.managedSettings).toBeUndefined();
      expect(next?.settings.hooks).toEqual(stopHook('notify'));
      expect(replies()).toEqual(['reply 1', expect.stringContaining(LOCK_NOTICE), 'reply 1']);
    }));

  it("with the lock dropped, a chat spawns with the user's hooks as flag settings and says so once", () =>
    inHookedWorktree(false, async (_tmpRoot, worktree) => {
      const chat = randomUUID();

      const options = await sendFromChatIn(claudeQueryMock, send, worktree, chat);
      await sendFromChatIn(claudeQueryMock, send, worktree, chat);

      expect(options?.plugins).toBeUndefined();
      expect(options?.managedSettings).toBeUndefined();
      expect(options?.settings.hooks).toEqual(stopHook('notify'));
      expect(claudeQueryMock).toHaveBeenCalledTimes(2);
      expect(replies()).toEqual([expect.stringContaining(LOCK_NOTICE), 'reply 1', 'reply 1']);
    }));
}
