import { describe, expect, it } from 'vitest';
import {
  CodexHostPermissionDeduper,
  mapFrinkHostPermissionRequests,
  parseFrinkHostToolPermissionRequest,
} from './codex-host-permissions';

const commandRequest = {
  protocolVersion: 1,
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  kind: 'command',
  toolName: 'Bash',
  input: { command: 'pwd' },
  cwd: '/repo',
} as const;

describe('Frink Codex host permission contract', () => {
  it('accepts the exact versioned request and rejects malformed or future versions', () => {
    expect(parseFrinkHostToolPermissionRequest(commandRequest)).toMatchObject(commandRequest);
    expect(
      parseFrinkHostToolPermissionRequest({ ...commandRequest, protocolVersion: 2 }),
    ).toBeNull();
    expect(parseFrinkHostToolPermissionRequest({ ...commandRequest, turnId: '' })).toBeNull();
    expect(
      parseFrinkHostToolPermissionRequest({ ...commandRequest, kind: 'mcp', mcp: undefined }),
    ).toBeNull();
  });

  it('maps every verified patch effect to its atomic file-operation gate', () => {
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'applyPatch',
      toolName: 'apply_patch',
      input: { patch: '*** Begin Patch' },
      patchEffects: [
        { operation: 'update', path: '/repo/a.ts' },
        { operation: 'move', path: '/repo/b.ts', destination: '/repo/c.ts' },
      ],
    });
    expect(parsed && mapFrinkHostPermissionRequests(parsed)).toEqual([
      { toolName: 'Edit', input: { file_path: '/repo/a.ts' } },
      { toolName: 'Delete', input: { file_path: '/repo/b.ts' } },
      { toolName: 'Write', input: { file_path: '/repo/c.ts' } },
    ]);
  });

  it('resolves relative patch effects against the provider effective cwd', () => {
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      cwd: '/tmp/worktree',
      kind: 'applyPatch',
      toolName: 'apply_patch',
      input: { patch: '*** Begin Patch' },
      patchEffects: [
        { operation: 'update', path: 'src/a.ts' },
        { operation: 'move', path: '../old.ts', destination: 'nested/new.ts' },
      ],
    });
    expect(parsed && mapFrinkHostPermissionRequests(parsed)).toEqual([
      { toolName: 'Delete', input: { file_path: '/tmp/old.ts' } },
      { toolName: 'Write', input: { file_path: '/tmp/worktree/nested/new.ts' } },
      { toolName: 'Edit', input: { file_path: '/tmp/worktree/src/a.ts' } },
    ]);
  });

  it('rejects patch requests without an absolute cwd and mismatched MCP identities', () => {
    expect(
      parseFrinkHostToolPermissionRequest({
        ...commandRequest,
        cwd: 'relative',
        kind: 'applyPatch',
        toolName: 'apply_patch',
        input: { patch: 'x' },
        patchEffects: [{ operation: 'update', path: 'a.ts' }],
      }),
    ).toBeNull();
    expect(
      parseFrinkHostToolPermissionRequest({
        ...commandRequest,
        kind: 'mcp',
        toolName: 'mcp__safe__read',
        input: { flowId: 'flow-1' },
        mcp: { server: 'frink_dynamic_chat', tool: 'frink_flows_patch' },
      }),
    ).toBeNull();
  });

  it('preserves the provider MCP identity without reparsing the flattened tool name', () => {
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'mcp',
      toolName: 'mcp__frink_dynamic_chat__evil__x',
      input: {},
      mcp: { server: 'frink_dynamic_chat__evil', tool: 'x' },
    });
    expect(parsed && mapFrinkHostPermissionRequests(parsed)).toEqual([
      {
        toolName: 'mcp__frink_dynamic_chat__evil__x',
        input: {},
        mcp: { server: 'frink_dynamic_chat__evil', tool: 'x' },
      },
    ]);
  });

  it('requires provider MCP tool names to preserve the canonical raw identity', () => {
    const raw = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'mcp',
      toolName: 'mcp__foo-bar__stories-list',
      input: {},
      mcp: { server: 'foo-bar', tool: 'stories-list' },
    });
    expect(raw).not.toBeNull();
    expect(
      parseFrinkHostToolPermissionRequest({
        ...commandRequest,
        kind: 'mcp',
        toolName: 'mcp__foo_bar__stories_list',
        input: {},
        mcp: { server: 'foo-bar', tool: 'stories-list' },
      }),
    ).toBeNull();
  });

  it('keeps MCP resource protocol operations distinct from callable tool names', () => {
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'mcp',
      toolName: 'mcp__context7__resources/read',
      input: { server: 'context7', uri: 'docs://rust' },
      mcp: { server: 'context7', tool: 'resources/read' },
    });
    expect(parsed && mapFrinkHostPermissionRequests(parsed)).toEqual([
      {
        toolName: 'mcp__context7__resources/read',
        input: { server: 'context7', uri: 'docs://rust' },
        mcp: { server: 'context7', tool: 'resources/read' },
      },
    ]);
    expect(parsed?.toolName).not.toBe('mcp__context7__read_mcp_resource');
  });

  it('maps non-empty writeStdin chars to the Bash command and rejects empty input', () => {
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'writeStdin',
      input: { command: 'yes\n', session_id: 42 },
    });
    expect(parsed && mapFrinkHostPermissionRequests(parsed)).toEqual([
      { toolName: 'Bash', input: { command: 'yes\n', cwd: '/repo' } },
    ]);
    expect(
      parseFrinkHostToolPermissionRequest({
        ...commandRequest,
        kind: 'writeStdin',
        input: { command: '', session_id: 42 },
      }),
    ).toBeNull();
  });

  it('deduplicates a downstream MCP call once and only for exact identity and arguments', () => {
    const deduper = new CodexHostPermissionDeduper();
    const parsed = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'mcp',
      toolName: 'mcp__frink_dynamic_chat__frink_flows_patch',
      input: { flowId: 'flow-1' },
      mcp: { server: 'frink_dynamic_chat', tool: 'frink_flows_patch' },
    });
    if (!parsed) throw new Error('fixture must parse');
    deduper.remember(parsed);
    expect(
      deduper.consumeMcp(
        'thread-1',
        'turn-1',
        'item-1',
        'frink_dynamic_chat',
        'frink_flows_patch',
        {
          flowId: 'different',
        },
      ),
    ).toBe(false);
    deduper.remember(parsed);
    expect(
      deduper.consumeMcp(
        'thread-1',
        'turn-1',
        'item-1',
        'frink_dynamic_chat',
        'frink_flows_patch',
        {
          flowId: 'flow-1',
        },
      ),
    ).toBe(true);
    expect(
      deduper.consumeMcp(
        'thread-1',
        'turn-1',
        'item-1',
        'frink_dynamic_chat',
        'frink_flows_patch',
        {
          flowId: 'flow-1',
        },
      ),
    ).toBe(false);
  });

  it('clears only approvals owned by the completed turn', () => {
    const deduper = new CodexHostPermissionDeduper();
    const first = parseFrinkHostToolPermissionRequest({
      ...commandRequest,
      kind: 'mcp',
      toolName: 'mcp__frink_dynamic_chat__frink_flows_patch',
      input: { flowId: 'flow-1' },
      mcp: { server: 'frink_dynamic_chat', tool: 'frink_flows_patch' },
    });
    if (!first) throw new Error('fixture must parse');
    const second = parseFrinkHostToolPermissionRequest({
      ...first,
      turnId: 'turn-2',
    });
    if (!second) throw new Error('fixture must parse');
    deduper.remember(first);
    deduper.remember(second);
    deduper.clearTurn('thread-1', 'turn-1');

    const consume = (turnId: string) =>
      deduper.consumeMcp('thread-1', turnId, 'item-1', 'frink_dynamic_chat', 'frink_flows_patch', {
        flowId: 'flow-1',
      });
    expect(consume('turn-1')).toBe(false);
    expect(consume('turn-2')).toBe(true);
  });
});
