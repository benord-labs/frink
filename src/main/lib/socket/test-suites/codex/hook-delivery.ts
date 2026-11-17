import { expect, it, vi } from 'vitest';
import * as hookLaunch from '../../../provider/hooks/store/launch';
import type { ExecutorPermissionHarness } from '../executor-codex-permissions';

type CodexHookHarness = Pick<
  ExecutorPermissionHarness,
  | 'basePayload'
  | 'codexCredential'
  | 'getDefaultClaudeCodeToken'
  | 'handleRemoteExecute'
  | 'runCodexAgent'
>;

/** Registers the cases proving a Codex turn gets the user's stored hooks, and only a live one. */
export function registerCodexHookTests({
  basePayload,
  codexCredential,
  getDefaultClaudeCodeToken,
  handleRemoteExecute,
  runCodexAgent,
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
