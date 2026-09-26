import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level constants bind the home at import time; a rig boot must still land on its own (sc-2903).
describe('MCP paths bind the home Frink owns', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('roots config and credentials under FRINK_HOME', async () => {
    vi.stubEnv('FRINK_HOME', '/rig/home');
    const { FRINK_MCP_CONFIG_PATH, FRINK_MCP_CREDENTIALS_PATH, FRINK_MCP_DIR } = await import(
      './config'
    );
    expect(FRINK_MCP_DIR).toBe(join('/rig/home', '.frink', 'mcp'));
    expect(FRINK_MCP_CONFIG_PATH).toBe(join(FRINK_MCP_DIR, 'config.json'));
    expect(FRINK_MCP_CREDENTIALS_PATH).toBe(join(FRINK_MCP_DIR, 'credentials.json'));
  });
});
