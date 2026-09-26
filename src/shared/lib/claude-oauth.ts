/**
 * Shared Claude OAuth constants
 * Used by both main (backend) and renderer (frontend)
 */

export const CLAUDE_OAUTH_CONFIG = {
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  AUTH_ENDPOINT: 'https://claude.ai/oauth/authorize',
  // api.anthropic.com token endpoint (no Cloudflare protection)
  TOKEN_ENDPOINT: 'https://api.anthropic.com/oauth/token',
  SCOPES: ['org:create_api_key', 'user:profile', 'user:inference'],
  // Port 3000 works for redirect URI
  CALLBACK_PORTS: [3000, 8080, 8000, 8915, 8916],
  // Standard callback path
  CALLBACK_PATH: '/callback',
} as const;

/**
 * Get scopes as space-separated string (OAuth standard format)
 */
export function getClaudeOAuthScopes(): string {
  return CLAUDE_OAUTH_CONFIG.SCOPES.join(' ');
}
