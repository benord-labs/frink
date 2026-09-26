import { describe, expect, it, vi } from 'vitest';

// Tests cover the un-gated Flows-on prompt content. Mock the launch flag on so
// the Flows section + behavioral lines remain in FRINK_PLATFORM_BLOCK.
vi.mock('../../shared/launch-flags', () => ({
  LAUNCH_FLAGS: {
    flows: true,
    workQueue: true,
    integrations: true,
  },
}));

const readAgentsMdMock = vi.fn<() => Promise<string | undefined>>();

vi.mock('./claude/read-agents-md', () => ({
  readAgentsMd: readAgentsMdMock,
}));

// Import after mocking
const { FRINK_PLATFORM_BLOCK, buildFrinkSystemPromptAppend } =
  await import('./frink-system-prompt');

describe('FRINK_PLATFORM_BLOCK', () => {
  it('is non-empty and mentions Frink', () => {
    expect(FRINK_PLATFORM_BLOCK.length).toBeGreaterThan(0);
    expect(FRINK_PLATFORM_BLOCK).toContain('Frink');
  });

  it('mentions Flows', () => {
    expect(FRINK_PLATFORM_BLOCK).toContain('Flows');
  });

  it('mentions Flow Briefing', () => {
    expect(FRINK_PLATFORM_BLOCK).toContain('Flow Briefing');
  });

  it('directs MCP config to Frink Settings, not Claude config files', () => {
    expect(FRINK_PLATFORM_BLOCK).toContain('~/.frink/mcp/config.json');
    expect(FRINK_PLATFORM_BLOCK).toContain('Frink Settings');
  });
});

describe('buildFrinkSystemPromptAppend', () => {
  it('returns non-empty string even without AGENTS.md or multi-project', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Frink');
  });

  it('includes Frink platform block', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result).toContain(FRINK_PLATFORM_BLOCK);
  });

  it('includes AGENTS.md content when file exists', async () => {
    readAgentsMdMock.mockResolvedValue('# My project rules\nDo X, not Y.');
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result).toContain('My project rules');
    expect(result).toContain('AGENTS.md');
  });

  it('omits AGENTS.md header when file does not exist', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result).not.toContain('AGENTS.md');
  });

  it('includes multi-project prefix when provided', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      multiProjectPrefix: '<multi_project_tools>switch project instructions</multi_project_tools>',
    });
    expect(result).toContain('multi_project_tools');
    expect(result).toContain('switch project instructions');
  });

  it('omits multi-project block when prefix is empty string', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      multiProjectPrefix: '',
    });
    expect(result).not.toContain('multi_project_tools');
  });

  it('omits multi-project block when prefix is undefined', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result).not.toContain('multi_project_tools');
  });

  it('assembles parts in order: Frink block, AGENTS.md, multi-project', async () => {
    readAgentsMdMock.mockResolvedValue('agents instructions here');
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      multiProjectPrefix: 'multi-project-block',
    });
    const frinkIdx = result.indexOf('# Frink');
    const agentsIdx = result.indexOf('agents instructions here');
    const multiIdx = result.indexOf('multi-project-block');
    expect(frinkIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThan(frinkIdx);
    expect(multiIdx).toBeGreaterThan(agentsIdx);
  });

  it('leaves interactive task completion to the native Stop hook', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: true,
    });
    expect(result).not.toContain('frink_task_signal');
    expect(result).not.toContain('Task lifecycle requirement');
  });

  it('omits task lifecycle block when isTaskExecution is false', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: false,
    });
    expect(result).not.toContain('frink_task_signal');
  });

  it('omits task lifecycle block when isTaskExecution is not provided', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({ cwd: '/some/cwd' });
    expect(result).not.toContain('frink_task_signal');
  });

  // Plan mode on the Claude path must point at the native plan workflow (ExitPlanMode) and
  // never demand the signal tool or a tool absent from the session's tool list.
  it('appends the Claude plan-mode block (not the signal-demand lifecycle block) when isPlanMode', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: true,
      isPlanMode: true,
    });
    expect(result).toContain('PLAN MODE');
    expect(result).toContain('ExitPlanMode');
    expect(result).not.toContain('Task lifecycle requirement');
  });

  // An auto-approve flow node implements in-turn after ExitPlanMode, so its run ends on that
  // implementation — the plan blocks above say the opposite, and this block must override them.
  // Without it the agent is instructed not to signal, ends quiet, and the node hangs until the
  // 25-minute idle sweep parks it.
  it('tells an auto-approve flow plan node that the run ends on the implementation', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: true,
      isPlanMode: true,
      isFlowDriven: true,
      planAutoApprove: true,
    });
    expect(result).toContain('ExitPlanMode does NOT end this run');
    expect(result).toContain('the run ends on that implementation');
    // The override must come AFTER the blocks it contradicts, or the agent reads the stale rule last.
    expect(result.indexOf('ExitPlanMode does NOT end this run')).toBeGreaterThan(
      result.indexOf('the plan is this run'),
    );
  });

  // Which state to send, and what `done` means, belong to the frink_task_signal tool description
  // alone. Restating them here let the agent read `done` as "done implementing the plan" rather
  // than "the node's work is complete" — two sources of truth for one word.
  it('leaves the terminal-state vocabulary to the tool description', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: true,
      isPlanMode: true,
      isFlowDriven: true,
      planAutoApprove: true,
    });
    expect(result).not.toContain('state="done"');
    expect(result).not.toContain('partial | blocked | failed');
  });

  it('does not demand a signal from a strict (human-gated) flow plan node', async () => {
    readAgentsMdMock.mockResolvedValue(undefined);
    const result = await buildFrinkSystemPromptAppend({
      cwd: '/some/cwd',
      isTaskExecution: true,
      isPlanMode: true,
      isFlowDriven: true,
      planAutoApprove: false,
    });
    expect(result).not.toContain('ExitPlanMode does NOT end this run');
  });
});
