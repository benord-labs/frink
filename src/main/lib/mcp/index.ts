/**
 * Frink MCP Module
 *
 * Provides MCP server management across all AI providers.
 */

// Config management
export {
  getGlobalMcpServers,
  getMcpCredentials,
  hasMcpCredentials,
  normalizeMcpServerConfigForStorage,
  readMcpConfigSync,
  readMcpCredentials,
  readProjectLocalMcpConfig,
  removeGlobalMcpServer,
  removeMcpCredentials,
  setGlobalMcpServer,
  setMcpCredentials,
} from './config';

// Types
export * from './types';
