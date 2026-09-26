import { describe, expect, it } from 'vitest';
import type { ClaudeConfig } from './claude-config';
import { GLOBAL_MCP_PATH, removeMcpServerConfig } from './claude-config';

describe('removeMcpServerConfig', () => {
  it('removes a global MCP server when projectPath is null', () => {
    const config: ClaudeConfig = {
      mcpServers: {
        'my-server': { command: 'npx', args: ['-y', 'my-server'] },
        'keep-server': { command: 'node', args: ['keep.js'] },
      },
    };
    const result = removeMcpServerConfig(config, null, 'my-server');
    expect(result.mcpServers?.['my-server']).toBeUndefined();
    expect(result.mcpServers?.['keep-server']).toBeDefined();
  });

  it('removes a global MCP server when projectPath is GLOBAL_MCP_PATH', () => {
    const config: ClaudeConfig = {
      mcpServers: {
        'test-server': { command: 'test' },
      },
    };
    const result = removeMcpServerConfig(config, GLOBAL_MCP_PATH, 'test-server');
    expect(result.mcpServers?.['test-server']).toBeUndefined();
  });

  it('is a no-op when global server does not exist', () => {
    const config: ClaudeConfig = {
      mcpServers: {
        existing: { command: 'test' },
      },
    };
    const result = removeMcpServerConfig(config, null, 'nonexistent');
    expect(result.mcpServers?.existing).toBeDefined();
  });

  it('removes a project-scoped MCP server', () => {
    const config: ClaudeConfig = {
      projects: {
        '/my/project': {
          mcpServers: {
            'proj-server': { command: 'proj' },
            'other-server': { command: 'other' },
          },
        },
      },
    };
    const result = removeMcpServerConfig(config, '/my/project', 'proj-server');
    expect(result.projects?.['/my/project']?.mcpServers?.['proj-server']).toBeUndefined();
    expect(result.projects?.['/my/project']?.mcpServers?.['other-server']).toBeDefined();
  });

  it('cleans up empty mcpServers object after last server removed', () => {
    const config: ClaudeConfig = {
      projects: {
        '/my/project': {
          mcpServers: {
            'only-server': { command: 'solo' },
          },
          allowedTools: ['read'],
        },
      },
    };
    const result = removeMcpServerConfig(config, '/my/project', 'only-server');
    expect(result.projects?.['/my/project']?.mcpServers).toBeUndefined();
    expect(result.projects?.['/my/project']?.allowedTools).toEqual(['read']);
  });

  it('cleans up empty project entry after last property removed', () => {
    const config: ClaudeConfig = {
      projects: {
        '/my/project': {
          mcpServers: {
            'only-server': { command: 'solo' },
          },
        },
      },
    };
    const result = removeMcpServerConfig(config, '/my/project', 'only-server');
    expect(result.projects?.['/my/project']).toBeUndefined();
  });

  it('is a no-op when project-scoped server does not exist', () => {
    const config: ClaudeConfig = {
      projects: {
        '/my/project': {
          mcpServers: {
            existing: { command: 'test' },
          },
        },
      },
    };
    const result = removeMcpServerConfig(config, '/my/project', 'nonexistent');
    expect(result.projects?.['/my/project']?.mcpServers?.existing).toBeDefined();
  });
});
