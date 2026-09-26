import { describe, expect, it } from 'vitest';
import {
  appendIdentityToEndpointUrl,
  channelOwner,
  getChannelToken,
  invalidateChannelToken,
  parseExecutionIdentity,
  retireChannelToken,
  setChannelToken,
  withChannelQuery,
} from './execution-identity';

describe('withChannelQuery', () => {
  it('carries the channel and the toolset discriminator', () => {
    const url = new URL(withChannelQuery('http://localhost:3111/mcp', 'tok-q', 'plan', true));
    expect(url.searchParams.get('channel')).toBe('tok-q');
    expect(url.searchParams.get('toolset')).toBe('plan:signal');
  });

  it('never adds a per-run executionId — that is what goes stale in a reused process', () => {
    expect(withChannelQuery('http://localhost:3111/mcp', 'tok-q', 'agent', false)).not.toContain(
      'executionId',
    );
  });

  it('returns original baseUrl when URL parsing fails', () => {
    expect(withChannelQuery('http://%', 'tok-q', 'agent', true)).toBe('http://%');
  });
});

describe('channel tokens', () => {
  it('mints one stable token per runtime and sub-chat and resolves it back', () => {
    const first = getChannelToken('sub-a', 'codex');
    expect(getChannelToken('sub-a', 'codex')).toBe(first);
    expect(getChannelToken('sub-b', 'codex')).not.toBe(first);
    expect(getChannelToken('sub-a', 'claude')).not.toBe(first);
    expect(channelOwner(first)).toEqual({ subChatId: 'sub-a', runtime: 'codex' });
  });

  it('resolves nothing for an unknown or absent channel', () => {
    expect(channelOwner('never-minted')).toBeUndefined();
    expect(channelOwner(undefined)).toBeUndefined();
  });

  it("makes a new process's token current and retires the one before it", () => {
    const older = getChannelToken('sub-cli', 'claude');
    setChannelToken('sub-cli', 'claude', 'tok-cli-2');
    expect(channelOwner(older)).toBeUndefined();
    expect(getChannelToken('sub-cli', 'claude')).toBe('tok-cli-2');
  });

  it("retires a process's own token, never the successor that replaced it", () => {
    const older = getChannelToken('sub-retire', 'claude');
    setChannelToken('sub-retire', 'claude', 'tok-successor');
    retireChannelToken(older);
    expect(channelOwner('tok-successor')).toEqual({ subChatId: 'sub-retire', runtime: 'claude' });
    retireChannelToken('tok-successor');
    expect(channelOwner('tok-successor')).toBeUndefined();
  });
});

describe('parseExecutionIdentity', () => {
  it('reads the channel and toolset, or neither', () => {
    expect(parseExecutionIdentity('/mcp?channel=tok-1&toolset=agent%3Asignal')).toEqual({
      channel: 'tok-1',
      toolset: 'agent:signal',
    });
    expect(parseExecutionIdentity('/mcp?executionId=run-1')).toEqual({
      channel: undefined,
      toolset: undefined,
    });
    expect(parseExecutionIdentity('/mcp')).toEqual({});
    expect(parseExecutionIdentity(undefined)).toEqual({});
  });
});

describe('invalidateChannelToken', () => {
  it('retires the mapping so a stale token resolves to nothing and the next spawn mints fresh', () => {
    // A superseded turn's in-flight request must not resolve onto the next
    // turn's run (and inherit its permission consent) — disposal rotates.
    const token = getChannelToken('sub-rotate', 'claude');
    invalidateChannelToken('sub-rotate', 'claude');
    expect(channelOwner(token)).toBeUndefined();
    expect(getChannelToken('sub-rotate', 'claude')).not.toBe(token);
  });

  it("leaves the other runtime's token for the same sub-chat alone", () => {
    const codex = getChannelToken('sub-both', 'codex');
    invalidateChannelToken('sub-both', 'claude');
    expect(channelOwner(codex)).toEqual({ subChatId: 'sub-both', runtime: 'codex' });
  });

  it('is a no-op for a sub-chat that never minted a token', () => {
    expect(() => invalidateChannelToken('sub-never', 'codex')).not.toThrow();
  });
});

describe('appendIdentityToEndpointUrl', () => {
  it('echoes the channel and toolset back rather than resolving them to a run', () => {
    const url = appendIdentityToEndpointUrl('http://127.0.0.1:3111', {
      channel: 'tok-1',
      toolset: 'plan:nosignal',
    });
    expect(url).toContain('channel=tok-1');
    expect(url).toContain('toolset=plan%3Anosignal');
    expect(url).not.toContain('executionId');
  });
});
