import { describe, expect, it } from 'vitest';
import {
  earlyJsonRpcReply,
  MCP_PROTOCOL_VERSION,
  resolveInitializeProtocolVersion,
} from './protocol-version';

describe('protocol-version', () => {
  it('returns client protocolVersion when provided', () => {
    const version = resolveInitializeProtocolVersion({ protocolVersion: '2025-11-25' });
    expect(version).toBe('2025-11-25');
  });

  it('falls back to default protocol version when missing', () => {
    const version = resolveInitializeProtocolVersion({ capabilities: {} });
    expect(version).toBe(MCP_PROTOCOL_VERSION);
  });

  it('falls back when params is malformed', () => {
    expect(resolveInitializeProtocolVersion(null)).toBe(MCP_PROTOCOL_VERSION);
    expect(resolveInitializeProtocolVersion('bad')).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe('earlyJsonRpcReply', () => {
  it('leaves requests to the handler, accepts notifications with 202 and no body', () => {
    expect(earlyJsonRpcReply({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeNull();
    expect(earlyJsonRpcReply({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      status: 202,
    });
  });

  it('answers malformed messages with Invalid Request instead of throwing', () => {
    for (const message of [null, 7, { jsonrpc: '2.0', method: 'tools/list' }, { id: 3 }]) {
      expect(earlyJsonRpcReply(message)).toMatchObject({
        status: 200,
        body: { error: { code: -32600 } },
      });
    }
    expect(earlyJsonRpcReply({ id: 3 })?.body).toMatchObject({ id: 3 });
  });
});
