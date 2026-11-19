import { expect, it, vi } from 'vitest';
import type { ExecutorPermissionHarness } from '../executor-codex-permissions';

type CodexAttachmentHarness = Pick<
  ExecutorPermissionHarness,
  | 'basePayload'
  | 'codexCredential'
  | 'getDefaultClaudeCodeToken'
  | 'handleRemoteExecute'
  | 'runCodexAgent'
  | 'socketClient'
>;

/** Registers the case proving a Codex shell read reaches the gate with this chat's session folder. */
export function registerCodexAttachmentReadTests({
  basePayload,
  codexCredential,
  getDefaultClaudeCodeToken,
  handleRemoteExecute,
  runCodexAgent,
  socketClient,
}: CodexAttachmentHarness): void {
  it("hands a Codex shell read the chat's own session folder, so attachments need no card", async () => {
    const { checkPermission } = await import('../../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({ decision: 'allow' });
    const session = `/mock/userData/claude-sessions/${basePayload.subChatId}`;
    const command = `cat '${session}/pasted/ab12cd34-notes.txt'`;
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({ toolName: 'Bash', input: { command } });
      yield { type: 'finish' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex reads an attachment' });

    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]).toMatchObject({
      tool: 'Bash',
      input: { command },
      sessionDirRoot: session,
    });
    expect(approval).toEqual({ allowed: true });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });
}
