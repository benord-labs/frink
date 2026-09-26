// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { appStore } from '../../../lib/jotai-store';
import { type Message, type MessagePart, messageAtomFamily } from '../stores/message-store';
import {
  detectExternalSideEffects,
  externalSideEffectsForMessage,
} from './detect-external-side-effects';

function part(type: string, extra: Partial<MessagePart> = {}): MessagePart {
  return { type, state: 'output-available', ...extra };
}

function assistant(id: string, parts: MessagePart[]): Message {
  return { id, role: 'assistant', parts };
}

describe('externalSideEffectsForMessage', () => {
  it('flags an MCP write whose verb is a SUFFIX (the screenshot case)', () => {
    const msg = assistant('a1', [part('tool-mcp__shortcut-frink__stories-update')]);
    expect(externalSideEffectsForMessage(msg)).toEqual([
      { tool: 'tool-mcp__shortcut-frink__stories-update', label: 'shortcut-frink: Stories Update' },
    ]);
  });

  it('flags multi-segment write verbs (stories-create-comment)', () => {
    const msg = assistant('a1', [part('tool-mcp__shortcut-frink__stories-create-comment')]);
    expect(externalSideEffectsForMessage(msg)).toHaveLength(1);
  });

  it('does NOT flag read tools (list / get-by-id / search)', () => {
    const msg = assistant('a1', [
      part('tool-mcp__shortcut-frink__stories-list'),
      part('tool-mcp__shortcut-frink__stories-get-by-id'),
      part('tool-mcp__shortcut-frink__stories-search'),
    ]);
    expect(externalSideEffectsForMessage(msg)).toEqual([]);
  });

  it('does NOT flag a write that errored or returned success:false', () => {
    const msg = assistant('a1', [
      part('tool-mcp__shortcut-frink__stories-update', { state: 'output-error' }),
      part('tool-mcp__shortcut-frink__stories-create', { output: { success: false } }),
    ]);
    expect(externalSideEffectsForMessage(msg)).toEqual([]);
  });

  it('does NOT flag a write still streaming its input', () => {
    const msg = assistant('a1', [
      part('tool-mcp__shortcut-frink__stories-update', { state: 'input-streaming' }),
    ]);
    expect(externalSideEffectsForMessage(msg)).toEqual([]);
  });

  it('does NOT flag non-MCP tools (shell/http are never flagged)', () => {
    const msg = assistant('a1', [
      part('tool-bash', { input: { command: 'git push' } }),
      part('tool-Write'),
    ]);
    expect(externalSideEffectsForMessage(msg)).toEqual([]);
  });

  it('matches verbs as whole tokens, not substrings (no false positives on lookalikes)', () => {
    // "updates" / "settings" / "created" each CONTAIN a write verb as a substring but are
    // distinct tokens — matching them would fire spurious warnings users learn to ignore.
    const msg = assistant('a1', [
      part('tool-mcp__server__updates-feed'), // "updates" ≠ "update"
      part('tool-mcp__server__settings-get'), // "settings" ≠ "set"
      part('tool-mcp__server__created-stories-list'), // "created" ≠ "create"
    ]);
    expect(externalSideEffectsForMessage(msg)).toEqual([]);
  });

  it('flags real Shortcut writes whose verb is mid-name (assign / set / add)', () => {
    const msg = assistant('a1', [
      part('tool-mcp__shortcut-frink__stories-assign-current-user'),
      part('tool-mcp__shortcut-frink__stories-set-external-links'),
      part('tool-mcp__shortcut-frink__stories-add-external-link'),
    ]);
    expect(externalSideEffectsForMessage(msg)).toHaveLength(3);
  });

  it('returns empty for a message with no parts', () => {
    expect(externalSideEffectsForMessage({ id: 'a1', role: 'assistant' })).toEqual([]);
  });
});

describe('detectExternalSideEffects', () => {
  it('scans from the target user message to end, de-duplicates by label, ignores earlier turns', () => {
    appStore.set(messageAtomFamily('u0'), { id: 'u0', role: 'user', parts: [] });
    appStore.set(
      messageAtomFamily('a0'),
      assistant('a0', [part('tool-mcp__shortcut-frink__stories-update')]),
    );
    appStore.set(messageAtomFamily('u1'), { id: 'u1', role: 'user', parts: [] });
    appStore.set(
      messageAtomFamily('a1'),
      assistant('a1', [
        part('tool-mcp__shortcut-frink__stories-update'),
        part('tool-mcp__slack__post-message'),
      ]),
    );

    const ordered = ['u0', 'a0', 'u1', 'a1'];
    // Rolling back to u1 discards u1+a1 — the a0 write before u1 must be ignored.
    const result = detectExternalSideEffects(ordered, 'u1');
    expect(result).toEqual([
      { tool: 'tool-mcp__shortcut-frink__stories-update', label: 'shortcut-frink: Stories Update' },
      { tool: 'tool-mcp__slack__post-message', label: 'slack: Post Message' },
    ]);
  });

  it('returns empty when the target id is not present', () => {
    expect(detectExternalSideEffects(['x', 'y'], 'missing')).toEqual([]);
  });
});
