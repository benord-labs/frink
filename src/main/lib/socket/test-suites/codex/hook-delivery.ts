import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as hookLaunch from '../../../provider/hooks/store/launch';
import { repoWithWorktree } from '../../../test-utils/repo-with-worktree';
import type { ExecutorPermissionHarness } from '../executor-codex-permissions';

type CodexHookHarness = Pick<
  ExecutorPermissionHarness,
  | 'basePayload'
  | 'codexCredential'
  | 'getChatWithProjectAccount'
  | 'getDefaultClaudeCodeToken'
  | 'handleRemoteExecute'
  | 'runCodexAgent'
  | 'toolValidation'
>;

/** Registers the cases proving a Codex turn gets the user's stored hooks, and only a live one. */
export function registerCodexHookTests({
  basePayload,
  codexCredential,
  getChatWithProjectAccount,
  getDefaultClaudeCodeToken,
  handleRemoteExecute,
  runCodexAgent,
  toolValidation,
}: CodexHookHarness): void {
  it("hands Codex the user's stored hooks and the project folder their scripts resolve from", async () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command' as const, command: 'notify' }] }] };
    const launch = vi.spyOn(hookLaunch, 'hooksForLaunch').mockResolvedValue({ hooks });
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'finish' };
    });

    try {
      await handleRemoteExecute({ ...basePayload, message: 'codex with hooks' });

      const codexCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
      expect(launch).toHaveBeenCalledWith('codex', codexCall?.cwd);
      expect(codexCall?.userHooks).toEqual(hooks);
      expect(codexCall?.env.CLAUDE_PROJECT_DIR).toBe(codexCall?.cwd);
    } finally {
      launch.mockRestore();
    }
  });

  it("hands a worktree chat its main checkout's hooks, the folder their scripts resolve from", async () => {
    const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-hooks-')));
    const { repo, worktree } = repoWithWorktree(tmpRoot);
    // SAFETY: the executor reads only the chat's worktreePath from this row.
    const row = { chat: { worktreePath: worktree }, account: null } as Awaited<
      ReturnType<typeof getChatWithProjectAccount>
    >;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(row);
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation((p) =>
      p === worktree ? path.join(tmpRoot, 'permissions') : p,
    );
    const launch = vi.spyOn(hookLaunch, 'hooksForLaunch').mockResolvedValue({});
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'finish' };
    });

    try {
      await handleRemoteExecute({ ...basePayload, message: 'codex in a worktree' });

      const codexCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
      expect(codexCall?.cwd).toBe(worktree);
      expect(launch).toHaveBeenCalledWith('codex', repo);
      expect(codexCall?.env.CLAUDE_PROJECT_DIR).toBe(repo);
    } finally {
      launch.mockRestore();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('never starts the Codex turn when the chat is cancelled while its hooks load', async () => {
    const { abortActiveExecutionsForSubChats } = await import('../../executor');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    const launch = vi.spyOn(hookLaunch, 'hooksForLaunch').mockImplementation(async () => {
      abortActiveExecutionsForSubChats([basePayload.subChatId], 'chat deleted');
      return {};
    });
    try {
      await handleRemoteExecute({ ...basePayload, message: 'cancelled codex turn' });
    } finally {
      launch.mockRestore();
    }

    expect(runCodexAgent).not.toHaveBeenCalled();
  });
}
