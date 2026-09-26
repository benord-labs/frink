import { describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION, resolveInitializeProtocolVersion } from './protocol-version';

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
