// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../stores/message-store';
import { buildDiffLineKeys } from './agent-edit-line-keys';
import { getEditToolDenialState } from './agent-edit-permission';

describe('getEditToolDenialState', () => {
  it('detects explicit permissionDenied output flag', () => {
    const part: MessagePart = {
      type: 'tool-Write',
      output: { permissionDenied: true, error: 'Virtual folders are read-only.' },
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('read-only');
  });

  it('detects denial text from errorText', () => {
    const part: MessagePart = {
      type: 'tool-Edit',
      errorText: 'Virtual folders are read-only. write operations require a project context.',
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('project context');
  });

  it('does not mark normal edit output as denied', () => {
    const part: MessagePart = {
      type: 'tool-Edit',
      output: { structuredPatch: [{ lines: ['+line'] }] },
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
    expect(result.denialReason).toBe('');
  });

  it('detects readonly_mode code from output payload', () => {
    const part: MessagePart = {
      type: 'tool-Edit',
      output: { code: 'readonly_mode' },
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
  });

  it('detects Claude-style output-error denial', () => {
    const part: MessagePart = {
      type: 'tool-Write',
      state: 'output-error',
      errorText: 'Virtual folders are read-only. write operations require a project context.',
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('read-only');
  });

  it('does not mark generic output-error as permission denied', () => {
    const part: MessagePart = {
      type: 'tool-Edit',
      state: 'output-error',
      errorText: 'JSON parse failed at line 1',
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
    expect(result.denialReason).toContain('parse failed');
  });

  it('detects a denial keyword carried only by output.error', () => {
    const part: MessagePart = {
      type: 'tool-Write',
      output: { error: 'Write is blocked in read-only mode (virtual folder).' },
    };
    const result = getEditToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('blocked');
  });

  it('matches each error field independently rather than concatenating them', () => {
    // A keyword split across the two fields must NOT match: joining them would
    // invent a denial that neither field actually states.
    const part: MessagePart = {
      type: 'tool-Edit',
      errorText: 'Operation requires a project',
      output: { error: 'context missing' },
    };
    expect(getEditToolDenialState(part).permissionDenied).toBe(false);
  });

  it('treats an OS-level permission error as Blocked — the keyword shim cannot tell them apart', () => {
    // Known limitation, pinned deliberately: edit tools have no exitCode to gate on,
    // so a genuine filesystem EACCES reads as a Frink denial. New denial paths must
    // set output.permissionDenied rather than rely on wording.
    const part: MessagePart = {
      type: 'tool-Edit',
      state: 'output-error',
      errorText: "EACCES: permission denied, open '/etc/hosts'",
    };
    expect(getEditToolDenialState(part).permissionDenied).toBe(true);
  });
});

describe('buildDiffLineKeys', () => {
  it('creates unique keys for repeated added lines without line numbers', () => {
    const keys = buildDiffLineKeys([
      { type: 'added', content: '2. Select a scene' },
      { type: 'added', content: '2. Select a scene' },
      { type: 'added', content: '2. Select a scene' },
    ]);

    expect(keys).toEqual([
      'added-na-na-2. Select a scene',
      'added-na-na-2. Select a scene-1',
      'added-na-na-2. Select a scene-2',
    ]);
  });

  it('creates unique keys for repeated blank lines', () => {
    const keys = buildDiffLineKeys([
      { type: 'added', content: '' },
      { type: 'added', content: '' },
    ]);

    expect(keys).toEqual(['added-na-na-', 'added-na-na--1']);
  });

  it('keeps key generation deterministic for mixed line metadata', () => {
    const keys = buildDiffLineKeys([
      { type: 'context', content: 'const x = 1;', oldLineNo: 12, newLineNo: 12 },
      { type: 'context', content: 'const x = 1;', oldLineNo: 12, newLineNo: 12 },
      { type: 'removed', content: 'oldValue', oldLineNo: 40 },
      { type: 'removed', content: 'oldValue', oldLineNo: 40 },
      { type: 'added', content: 'newValue', newLineNo: 40 },
      { type: 'added', content: 'newValue', newLineNo: 40 },
    ]);

    expect(keys).toEqual([
      'context-12-12-const x = 1;',
      'context-12-12-const x = 1;-1',
      'removed-40-na-oldValue',
      'removed-40-na-oldValue-1',
      'added-na-40-newValue',
      'added-na-40-newValue-1',
    ]);
  });
});
