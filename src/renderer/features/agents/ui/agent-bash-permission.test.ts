import { describe, expect, it } from 'vitest';
import { TOOL_DENIAL_KEYWORDS } from '@/lib/agent-chat/tool-denial/keywords';
import type { MessagePart } from '../stores/message-store';
import { getBashToolDenialState } from './agent-bash-permission';
import { getEditToolDenialState } from './agent-edit-permission';

describe('getBashToolDenialState', () => {
  it('detects explicit permissionDenied in output (tool-output-available path)', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      output: { permissionDenied: true, error: 'Bash command denied by policy.' },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('denied by policy');
  });

  it('returns Failed when exitCode is 1 and no permissionDenied (command ran and failed)', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      output: { output: 'TypeError: Secondary flag is not valid...', exitCode: 1 },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
    expect(result.denialReason).toBe('');
  });

  it('returns Failed when exitCode is 0 (success)', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      output: { output: 'done', exitCode: 0 },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
  });

  it('tool-output-error with permissionDenied in output shows Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      errorText: 'Bash command denied by policy.',
      output: { permissionDenied: true, error: 'Bash command denied by policy.' },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toContain('denied by policy');
  });

  it('tool-output-error without permissionDenied and Python-style errorText shows Failed not Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      errorText:
        'TypeError: Secondary flag is not valid for non-boolean flag.\n  at typer/main.py:877',
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
    expect(result.denialReason).toContain('TypeError');
  });

  it('legacy: output-error + denial keyword in errorText and no exitCode shows Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      errorText: 'Bash command denied by policy.',
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
    expect(result.denialReason).toBe('Bash command denied by policy.');
  });

  it('legacy: output-error + "read-only" in errorText and no exitCode shows Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      errorText: 'Virtual folders are read-only.',
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
  });

  it('does not treat generic output-error with no denial keywords as Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      errorText: 'Command not found: poetry',
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
  });

  it('exitCode present (1) overrides any denial keyword in errorText', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-available',
      errorText: 'Access denied by server',
      output: { output: 'stderr', exitCode: 1 },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
  });

  it('mixed payload: permissionDenied true + exitCode present shows Failed not Blocked', () => {
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-available',
      output: { permissionDenied: true, error: 'Denied', exitCode: 1 },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
  });

  it('reports no denial reason when errorText is absent, whatever output.error says', () => {
    // The legacy path is gated on errorText, so output.error can never supply the
    // reason on this branch — only the explicit-flag path reads it.
    const part: MessagePart = {
      type: 'tool-Shell',
      state: 'output-error',
      output: { error: 'Bash command denied by policy.' },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(false);
    expect(result.denialReason).toBe('');
  });

  it('a null exitCode is absent, not a run result, so an explicit denial still shows Blocked', () => {
    // Providers that always emit the key (`exitCode: item.exitCode ?? null`) must not
    // trip the "command ran" short-circuit, which only fires for a numeric exitCode.
    const part: MessagePart = {
      type: 'tool-Shell',
      output: { permissionDenied: true, error: 'Bash command denied by policy.', exitCode: null },
    };
    const result = getBashToolDenialState(part);
    expect(result.permissionDenied).toBe(true);
  });
});

describe('denial keyword parity between bash and edit classifiers', () => {
  // Both classifiers must read ONE keyword list. Re-inlining a list in either
  // helper diverges them silently — this is the regression that guard exists for.
  it.each(TOOL_DENIAL_KEYWORDS)('agrees that %s marks a denial', (keyword) => {
    const errorText = `Tool call ${keyword} for this chat.`;
    expect(
      getBashToolDenialState({ type: 'tool-Shell', state: 'output-error', errorText }),
    ).toEqual(expect.objectContaining({ permissionDenied: true }));
    expect(getEditToolDenialState({ type: 'tool-Edit', state: 'output-error', errorText })).toEqual(
      expect.objectContaining({ permissionDenied: true }),
    );
  });

  it('agrees that an ordinary failure is not a denial', () => {
    const errorText = 'TypeError: flag is not valid';
    expect(
      getBashToolDenialState({ type: 'tool-Shell', state: 'output-error', errorText })
        .permissionDenied,
    ).toBe(false);
    expect(
      getEditToolDenialState({ type: 'tool-Edit', state: 'output-error', errorText })
        .permissionDenied,
    ).toBe(false);
  });
});
