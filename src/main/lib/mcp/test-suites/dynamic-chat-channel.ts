import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { buildCodexDynamicChatMcpUrl } from '../../agent-runner/codex/spawn-args';
import {
  type ChannelRuntime,
  getChannelToken,
  invalidateChannelToken,
  setChannelToken,
} from '../execution-identity';

/** Registers the cases proving a channel resolves only to the run bound to it, of its runtime. */

type DynamicChatModule = typeof import('../dynamic-chat-server');
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
type Mock = ReturnType<typeof vi.fn>;

type ChannelHarness = Pick<
  DynamicChatModule,
  | 'bindChannelExecution'
  | 'clearCurrentExecutionChat'
  | 'getLatestTaskSignal'
  | 'getOrStartDynamicChatMcpUrl'
  | 'setCurrentExecutionChat'
> & {
  state: { handleFlowsToolCall: Mock; validateToolPermission: Mock };
  callToolOverHttp: (
    name: string,
    args: Record<string, unknown>,
    channel?: string,
  ) => Promise<ToolResult>;
  listDynamicChatToolNames: (channel?: string, toolset?: string) => Promise<string[]>;
};

const NO_CONTEXT = 'requires an active execution context';
const signal = (summary: string) => ({ state: 'done', summary });

export function registerDynamicChatChannelTests(h: ChannelHarness): void {
  /** A run of `runtime` for the sub-chat. Codex binds its channel here; Claude binds at attach. */
  const run = (subChatId: string, runtime: ChannelRuntime, mode: ChatMode = 'agent', on = true) =>
    h.setCurrentExecutionChat(
      'chat',
      subChatId,
      '/project',
      mode,
      undefined,
      undefined,
      on,
      runtime,
    );
  const signalOver = (subChatId: string, runtime: ChannelRuntime, summary = 'Done.') =>
    h.callToolOverHttp('frink_task_signal', signal(summary), getChannelToken(subChatId, runtime));

  describe('dynamic-chat channels (a process reused across turns)', () => {
    afterEach(() => {
      h.clearCurrentExecutionChat();
      vi.clearAllMocks();
    });

    it('resolves to the CURRENT run after the arming turn tore its context down', async () => {
      // A reused process bakes its MCP URL in at spawn, so a per-run id there is dead from turn 2.
      const turnOne = run('sub-signal', 'codex');
      h.clearCurrentExecutionChat(turnOne);
      const turnTwo = run('sub-signal', 'codex');

      const result = await signalOver('sub-signal', 'codex');

      expect(result.isError).toBe(false);
      expect(h.getLatestTaskSignal(turnTwo)).toEqual(expect.objectContaining({ state: 'done' }));
    });

    it('resolves only its own sub-chat, never a concurrent one', async () => {
      const runA = run('sub-a', 'codex');
      const runB = run('sub-b', 'codex');

      await signalOver('sub-b', 'codex');

      expect(h.getLatestTaskSignal(runB)).toEqual(expect.objectContaining({ state: 'done' }));
      expect(h.getLatestTaskSignal(runA)).toBeUndefined();
    });

    it('resolves nothing between turns: a torn-down run, or a Claude run not yet attached', async () => {
      h.clearCurrentExecutionChat(run('sub-codex', 'codex'));
      const ended = run('sub-claude', 'claude');
      h.bindChannelExecution('sub-claude', ended);
      h.clearCurrentExecutionChat(ended);
      const next = run('sub-claude', 'claude');

      const results = [
        await signalOver('sub-codex', 'codex'),
        await signalOver('sub-claude', 'claude'),
      ];

      for (const result of results) expect(result.content[0]?.text).toContain(NO_CONTEXT);
      expect(h.getLatestTaskSignal(next)).toBeUndefined();
    });

    it("keeps a held burst's signal on the hold's run until the adopting turn binds its own", async () => {
      const held = run('sub-hold', 'claude');
      h.bindChannelExecution('sub-hold', held);
      const adopting = run('sub-hold', 'claude');

      await signalOver('sub-hold', 'claude', 'From the burst.');
      h.bindChannelExecution('sub-hold', adopting);
      await signalOver('sub-hold', 'claude', 'From the adopted turn.');

      expect(h.getLatestTaskSignal(held)?.summary).toBe('From the burst.');
      expect(h.getLatestTaskSignal(adopting)?.summary).toBe('From the adopted turn.');
    });

    it('resolves nothing once an abort has invalidated the token', async () => {
      h.bindChannelExecution('sub-abort', run('sub-abort', 'claude'));
      const token = getChannelToken('sub-abort', 'claude');
      invalidateChannelToken('sub-abort', 'claude');

      const result = await h.callToolOverHttp('frink_task_signal', signal('Late.'), token);

      expect(result.content[0]?.text).toContain(NO_CONTEXT);
    });

    it("resolves nothing for an older CLI's token once a successor CLI's run is bound", async () => {
      // The older CLI can outlive its session (a Stop on a held chat, an orphaned drain).
      const older = getChannelToken('sub-next', 'claude');
      setChannelToken('sub-next', 'claude', 'successor-cli');
      const next = run('sub-next', 'claude');
      h.bindChannelExecution('sub-next', next);

      const result = await h.callToolOverHttp('frink_task_signal', signal('Stale.'), older);

      expect(result.content[0]?.text).toContain(NO_CONTEXT);
      expect(h.getLatestTaskSignal(next)).toBeUndefined();
    });

    it("never resolves one runtime's token onto the other runtime's run of the sub-chat", async () => {
      const claudeRun = run('sub-switch', 'claude');
      h.bindChannelExecution('sub-switch', claudeRun);
      const codexMiss = await signalOver('sub-switch', 'codex');
      const codexRun = run('sub-switch', 'codex');
      const claudeMiss = await signalOver('sub-switch', 'claude');

      expect(codexMiss.content[0]?.text).toContain(NO_CONTEXT);
      expect(claudeMiss.content[0]?.text).toContain(NO_CONTEXT);
      expect(h.getLatestTaskSignal(claudeRun)).toBeUndefined();
      expect(h.getLatestTaskSignal(codexRun)).toBeUndefined();
    });

    it('resolves nothing for a channel that was never minted', async () => {
      run('sub-signal', 'codex');

      const result = await h.callToolOverHttp('frink_task_signal', signal('Done.'), 'not-a-token');

      expect(result.content[0]?.text).toContain(NO_CONTEXT);
    });

    it('still reports a disarmed signal as disarmed, not as a missing context', async () => {
      run('sub-signal', 'codex', 'agent', false);

      const result = await signalOver('sub-signal', 'codex');

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).not.toContain(NO_CONTEXT);
    });

    it('lets a Claude flow write through without a second prompt: its SDK callbacks asked', async () => {
      h.bindChannelExecution('sub-flow', run('sub-flow', 'claude'));
      const args = { name: 'flow', operations: [] };

      const result = await h.callToolOverHttp(
        'frink_flows_patch',
        args,
        getChannelToken('sub-flow', 'claude'),
      );

      expect(result.isError).toBe(false);
      expect(h.state.validateToolPermission).not.toHaveBeenCalled();
      expect(h.state.handleFlowsToolCall).toHaveBeenCalledOnce();
    });

    it("lists an unbound channel's tools from its URL toolset", async () => {
      const token = getChannelToken('sub-unbound', 'claude');

      const plan = await h.listDynamicChatToolNames(token, 'plan:nosignal');
      const agent = await h.listDynamicChatToolNames(token, 'agent:signal');

      expect(plan).not.toContain('frink_task_signal');
      expect(plan).not.toContain('frink_flows_patch');
      expect(agent).toContain('frink_task_signal');
      expect(agent).toContain('frink_flows_patch');
    });

    it.each([
      ['agent', true],
      ['plan', false],
    ] as const)('keeps the Codex %s URL: its stable channel plus its toolset', async (mode, on) => {
      const baseUrl = await h.getOrStartDynamicChatMcpUrl();
      const params = { baseUrl, subChatId: 'sub-codex', projectPath: '/repo', mode };
      const url = buildCodexDynamicChatMcpUrl({ ...params, hasSignalTask: on });
      const channel = getChannelToken('sub-codex', 'codex');
      const toolset = `${mode}:${on ? 'signal' : 'nosignal'}`;

      expect(url).toBe(`${baseUrl}/?channel=${channel}&toolset=${encodeURIComponent(toolset)}`);
    });
  });
}
