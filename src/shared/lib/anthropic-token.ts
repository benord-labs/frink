/**
 * Shared utilities for Anthropic token detection
 * Used by both main process and renderer
 */

/**
 * Check if a token is an Anthropic API key (vs OAuth token)
 * API keys: sk-ant-api03-... (must start with 'sk-ant-api')
 * OAuth tokens: sk-ant-oat01-... (contain 'oat')
 */
export function isAnthropicApiKey(token: string): boolean {
  const trimmed = token.trim();
  // OAuth tokens are never API keys.
  if (trimmed.startsWith('sk-ant-oat')) {
    return false;
  }
  return trimmed.startsWith('sk-ant-api');
}

/**
 * Check if a token is a Claude Code OAuth token
 * OAuth tokens start with 'sk-ant-oat' (e.g., sk-ant-oat01-...)
 */
export function isClaudeOAuthToken(token: string): boolean {
  return token.trim().startsWith('sk-ant-oat');
}
