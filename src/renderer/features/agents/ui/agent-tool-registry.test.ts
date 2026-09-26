import { describe, expect, it, vi } from 'vitest';

// getToolStatus' subagent override consults transport liveness; mock the transport module so the
// real one (Sentry/trpc/etc.) never loads and we can toggle the live/dead signal per case.
const { hasActiveTransportMock } = vi.hoisted(() => ({ hasActiveTransportMock: vi.fn() }));
vi.mock('../../../lib/stores/active-transport-registry', () => ({
  hasActiveTransport: hasActiveTransportMock,
}));

import {
  AgentToolRegistry,
  formatMcpToolName,
  getSubagentLabel,
  getToolStatus,
  isSubagentTaskPart,
  parseMcpToolType,
  resolveRegistryKey,
} from './agent-tool-registry';

describe('parseMcpToolType', () => {
  it('parses a well-formed tool-mcp__server__tool', () => {
    const info = parseMcpToolType('tool-mcp__codebase__searchCode');
    expect(info).toEqual({
      serverName: 'codebase',
      toolName: 'searchCode',
      displayName: 'SearchCode',
      category: 'other',
    });
  });

  it('parses a hyphen-cased tool name', () => {
    const info = parseMcpToolType('tool-mcp__shortcut__stories-search');
    expect(info?.serverName).toBe('shortcut');
    expect(info?.toolName).toBe('stories-search');
    expect(info?.displayName).toBe('Stories Search');
  });

  it('categorises by tool-name prefix', () => {
    expect(parseMcpToolType('tool-mcp__svc__search_items')?.category).toBe('search');
    expect(parseMcpToolType('tool-mcp__svc__list_items')?.category).toBe('list');
    expect(parseMcpToolType('tool-mcp__svc__get_thing')?.category).toBe('get');
    expect(parseMcpToolType('tool-mcp__svc__create_thing')?.category).toBe('create');
    expect(parseMcpToolType('tool-mcp__svc__delete_thing')?.category).toBe('delete');
    expect(parseMcpToolType('tool-mcp__svc__send_email')?.category).toBe('send');
    expect(parseMcpToolType('tool-mcp__svc__generate_image')?.category).toBe('generate');
  });

  it('treats the entire trailing segment as the tool name even when it contains __', () => {
    const info = parseMcpToolType('tool-mcp__server__a__b');
    expect(info?.serverName).toBe('server');
    expect(info?.toolName).toBe('a__b');
  });

  it('returns null for non-MCP tool prefix', () => {
    expect(parseMcpToolType('tool-Bash')).toBeNull();
    expect(parseMcpToolType('tool-foo__bar')).toBeNull();
    expect(parseMcpToolType('text')).toBeNull();
  });

  it('returns null when the server separator is missing', () => {
    expect(parseMcpToolType('tool-mcp__onlyone')).toBeNull();
  });
});

// Documents the routing-precedence contract used by assistant-message-item.tsx:
//   1. resolveRegistryKey(part.type) ∈ AgentToolRegistry  → registry card wins
//   2. parseMcpToolType(part.type) !== null              → AgentMcpToolCall
//   3. otherwise                                          → bare-text fallback
describe('routing precedence', () => {
  it('registered MCP short-form tools resolve into AgentToolRegistry (registry wins)', () => {
    const partType = 'tool-mcp__frink_dynamic_chat__frink_flows_patch';
    const resolved = resolveRegistryKey(partType);
    expect(resolved).toBe('tool-frink_flows_patch');
    expect(resolved in AgentToolRegistry).toBe(true);
  });

  it('treats persisted result state as terminal for Flow registry labels', () => {
    const part = {
      type: 'tool-frink_flows_define_stages',
      state: 'output-available' as const,
      input: { batchId: 'batch-123' },
    };
    expect(AgentToolRegistry['tool-frink_flows_define_stages'].title(part)).toBe('Defined Stages');
    expect('tool-frink_flows_start_batch' in AgentToolRegistry).toBe(true);
  });

  it('unregistered MCP tools fall through to parseMcpToolType (MCP card wins)', () => {
    const partType = 'tool-mcp__codebase__searchCode';
    const resolved = resolveRegistryKey(partType);
    expect(resolved in AgentToolRegistry).toBe(false);
    expect(parseMcpToolType(partType)).not.toBeNull();
  });

  it('non-MCP tools containing double underscores still hit the text fallback', () => {
    const partType = 'tool-foo__bar';
    const resolved = resolveRegistryKey(partType);
    expect(resolved in AgentToolRegistry).toBe(false);
    expect(parseMcpToolType(partType)).toBeNull();
  });
});

describe('tool-Skill', () => {
  it('resolves into the registry and surfaces the skill name', () => {
    expect('tool-Skill' in AgentToolRegistry).toBe(true);
    expect(resolveRegistryKey('tool-Skill')).toBe('tool-Skill');
    const meta = AgentToolRegistry['tool-Skill'];
    expect(
      meta.subtitle?.({
        type: 'tool-Skill',
        state: 'output-available',
        input: { skill: 'frink-flows' },
      }),
    ).toBe('frink-flows');
    // streaming: input not yet parsed → no half-typed slug
    expect(meta.subtitle?.({ type: 'tool-Skill', state: 'input-streaming', input: {} })).toBe('');
  });
});

describe('formatMcpToolName', () => {
  it('converts underscores to spaces and title-cases each word', () => {
    expect(formatMcpToolName('search_items')).toBe('Search Items');
    expect(formatMcpToolName('list_active_users')).toBe('List Active Users');
  });

  it('converts hyphens to spaces and title-cases each word', () => {
    expect(formatMcpToolName('stories-list')).toBe('Stories List');
    expect(formatMcpToolName('epics-create')).toBe('Epics Create');
  });

  it('handles real-world server tool names (playwright, neon)', () => {
    expect(formatMcpToolName('browser_navigate')).toBe('Browser Navigate');
    expect(formatMcpToolName('list_branches')).toBe('List Branches');
  });

  it('collapses repeated whitespace', () => {
    expect(formatMcpToolName('foo__bar')).toBe('Foo Bar');
  });

  it('returns the original word capitalised when no underscores are present', () => {
    expect(formatMcpToolName('searchCode')).toBe('SearchCode');
  });

  it('trims leading and trailing whitespace', () => {
    expect(formatMcpToolName('_foo_bar_')).toBe('Foo Bar');
  });
});

// Current Claude Code names the subagent-spawning tool `Agent`; older/native flows use
// `Task`. Both must render the same collapsible "Running/Completed Subagent" card.
describe('subagent card (tool-Task + tool-Agent)', () => {
  it('registers both Task and Agent against one shared (aliased) entry', () => {
    expect('tool-Task' in AgentToolRegistry).toBe(true);
    expect('tool-Agent' in AgentToolRegistry).toBe(true);
    expect(AgentToolRegistry['tool-Agent']).toBe(AgentToolRegistry['tool-Task']);
    expect(resolveRegistryKey('tool-Agent')).toBe('tool-Agent');
  });

  it('titles by status', () => {
    const meta = AgentToolRegistry['tool-Agent'];
    expect(meta.title({ type: 'tool-Agent', state: 'input-streaming' })).toBe('Preparing subagent');
    expect(meta.title({ type: 'tool-Agent', state: 'input-available' })).toBe('Running Subagent');
    expect(meta.title({ type: 'tool-Agent', state: 'output-available' })).toBe(
      'Completed Subagent',
    );
  });

  it('subtitle falls back across input shapes (description → subagent_type → prompt)', () => {
    const meta = AgentToolRegistry['tool-Agent'];
    const sub = (input: Record<string, unknown>) =>
      meta.subtitle?.({ type: 'tool-Agent', state: 'output-available', input });
    expect(sub({ description: 'Research X' })).toBe('Research X');
    expect(sub({ subagent_type: 'Explore' })).toBe('Explore');
    expect(sub({ prompt: 'do the thing' })).toBe('do the thing');
    // streaming: input not yet parsed → no half-typed text
    expect(meta.subtitle?.({ type: 'tool-Agent', state: 'input-streaming', input: {} })).toBe('');
    // truncates long labels at 50 chars
    expect(sub({ description: 'x'.repeat(60) })).toBe(`${'x'.repeat(47)}...`);
  });
});

// The card header and the collapsed nested row share this resolver, so a label
// regression would desync them. `Agent` parts may omit `description` entirely.
describe('getSubagentLabel', () => {
  it('prefers description, then subagent_type, then prompt', () => {
    expect(getSubagentLabel({ description: 'd', subagent_type: 's', prompt: 'p' })).toBe('d');
    expect(getSubagentLabel({ subagent_type: 's', prompt: 'p' })).toBe('s');
    expect(getSubagentLabel({ prompt: 'p' })).toBe('p');
  });

  it('returns empty string when no field is a non-empty string', () => {
    expect(getSubagentLabel({})).toBe('');
    expect(getSubagentLabel(undefined)).toBe('');
    expect(getSubagentLabel({ description: '' })).toBe('');
    // non-string values are ignored, not coerced
    expect(getSubagentLabel({ description: 42, subagent_type: null, prompt: { a: 1 } })).toBe('');
  });
});

// A subagent card is driven by the main process AFTER the root stream's status flips to 'ready',
// so we can't key its spinner off chatStatus alone. Instead the override keeps it pending only while
// the run is genuinely live (an active transport). After a server/main-process restart the transport
// is gone, so a pending card with no output must stop animating and read "interrupted".
describe('getToolStatus subagent liveness override', () => {
  // state:'input-available' + no output = a started-but-unfinished subagent (basePending && !output).
  const pendingSubagent = { type: 'tool-Agent' as const, state: 'input-available' as const };

  it('keeps the card pending (animating) while the transport is live', () => {
    hasActiveTransportMock.mockReturnValue(true);
    // chatStatus already 'ready' (root stream ended) — only liveness keeps it spinning.
    expect(getToolStatus(pendingSubagent, 'ready', 'sub-1')).toMatchObject({
      isPending: true,
      isInterrupted: false,
    });
  });

  it('falls through to interrupted (no animation) once the transport is gone — the restart case', () => {
    hasActiveTransportMock.mockReturnValue(false);
    expect(getToolStatus(pendingSubagent, 'ready', 'sub-1')).toMatchObject({
      isPending: false,
      isInterrupted: true,
    });
  });

  it('treats a missing subChatId as not-live (override only fires for the top-level card call)', () => {
    hasActiveTransportMock.mockReturnValue(true);
    expect(getToolStatus(pendingSubagent, 'ready')).toMatchObject({
      isPending: false,
      isInterrupted: true,
    });
  });

  it('a completed subagent (has output) is never overridden — stays done regardless of transport', () => {
    hasActiveTransportMock.mockReturnValue(false);
    const done = {
      type: 'tool-Agent' as const,
      state: 'output-available' as const,
      output: { result: 'ok' },
    };
    expect(getToolStatus(done, 'ready', 'sub-1')).toMatchObject({
      isPending: false,
      isInterrupted: false,
      isSuccess: true,
    });
  });

  // The override is purely additive: it may only KEEP a card pending, never downgrade one. A
  // genuinely-streaming card already animates via the base logic, so a dead-transport read here
  // (e.g. a brief window before the listener registers) must not flip it to interrupted.
  it('a still-streaming card keeps animating via base logic even when transport reads dead', () => {
    hasActiveTransportMock.mockReturnValue(false);
    expect(getToolStatus(pendingSubagent, 'streaming', 'sub-1')).toMatchObject({
      isPending: true,
      isInterrupted: false,
    });
  });

  // A subagent that errored carries a terminal output-error state, so it is not basePending and the
  // override never fires. After a restart it must still read as failed (isError), not "interrupted",
  // so the user does not lose the failure.
  it('an errored subagent stays failed (isError), not interrupted, when transport is dead', () => {
    hasActiveTransportMock.mockReturnValue(false);
    const errored = { type: 'tool-Agent' as const, state: 'output-error' as const };
    expect(getToolStatus(errored, 'ready', 'sub-1')).toMatchObject({
      isError: true,
      isPending: false,
      isInterrupted: false,
    });
  });

  // Liveness is keyed per subChatId, so concurrent runs in different panes/sub-chats are isolated:
  // a live sub-chat keeps animating while a dead one (post-restart) reads interrupted — same part.
  it('isolates liveness per subChatId across concurrent panes', () => {
    hasActiveTransportMock.mockImplementation((id: string) => id === 'live-sub');
    expect(getToolStatus(pendingSubagent, 'ready', 'live-sub')).toMatchObject({ isPending: true });
    expect(getToolStatus(pendingSubagent, 'ready', 'dead-sub')).toMatchObject({
      isInterrupted: true,
    });
  });

  // tool-Task (the executor's synthetic subagent cards) and tool-Agent (Claude Code)
  // share one code path via isSubagentTaskPart — the liveness override must behave identically.
  it('applies identically to tool-Task (provider parity with tool-Agent)', () => {
    const taskPart = { type: 'tool-Task' as const, state: 'input-available' as const };
    hasActiveTransportMock.mockReturnValue(true);
    expect(getToolStatus(taskPart, 'ready', 'sub-1')).toMatchObject({ isPending: true });
    hasActiveTransportMock.mockReturnValue(false);
    expect(getToolStatus(taskPart, 'ready', 'sub-1')).toMatchObject({ isInterrupted: true });
  });

  // Codex spawns subagents through its own collab protocol items rather than a Task tool. They are
  // minted under a shared pseudo-tool name so they reach the same card, timer and liveness rules.
  it('applies identically to the codex collab card (provider parity)', () => {
    const codexPart = { type: 'tool-CodexSubagent' as const, state: 'input-available' };
    expect(isSubagentTaskPart(codexPart)).toBe(true);
    hasActiveTransportMock.mockReturnValue(true);
    expect(getToolStatus(codexPart, 'ready', 'sub-1')).toMatchObject({ isPending: true });
    hasActiveTransportMock.mockReturnValue(false);
    expect(getToolStatus(codexPart, 'ready', 'sub-1')).toMatchObject({ isInterrupted: true });
  });

  // Upstream has no dangling-item sweeper: a codex item whose turn errors mid-flight (webSearch does
  // this on its error path) never sends item/completed. The chatStatus gate is the ONLY thing that
  // stops such a card animating forever, so pin it — a refactor of getToolStatus must not lose it.
  it('stops a never-completed card animating once the turn stops streaming', () => {
    const dangling = { type: 'tool-WebSearch' as const, state: 'input-available' };
    expect(getToolStatus(dangling, 'streaming')).toMatchObject({ isPending: true });
    expect(getToolStatus(dangling, 'ready')).toMatchObject({
      isPending: false,
      isInterrupted: true,
    });
  });
});

describe('data-compact card', () => {
  const meta = AgentToolRegistry['data-compact'];
  const part = (data: { state: string; trigger?: string }) => ({ type: 'data-compact', data });

  it('names each settled outcome', () => {
    expect(meta.title(part({ state: 'output-available' }))).toBe('Compacted');
    expect(meta.title(part({ state: 'output-error' }))).toBe('Compaction failed');
  });

  it('distinguishes an automatic compaction the user never asked for', () => {
    expect(meta.title(part({ state: 'output-available', trigger: 'auto' }))).toBe('Auto-compacted');
    expect(meta.title(part({ state: 'output-available', trigger: 'manual' }))).toBe('Compacted');
  });

  it('reads settled even mid-turn, since its state lives in data', () => {
    const done = getToolStatus(part({ state: 'output-available' }), 'streaming');
    expect(done.isPending).toBe(false);
    expect(done.isError).toBe(false);

    const failed = getToolStatus(part({ state: 'output-error' }), 'streaming');
    expect(failed.isError).toBe(true);
  });
});
