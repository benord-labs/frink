/**
 * Browser-based OAuth flow for Claude / Anthropic.
 *
 * The only Frink-owned OAuth path. Used by the `claudeCode` router's add-account
 * fallback (kept around because some users want a fresh OAuth without going through
 * the `claude` CLI). The dominant code path is now `claude-passthrough` via
 * `credentials/detect.ts` + `credentials/source-readers.ts`.
 *
 * Extracted from `src/main/lib/claude-token.ts` during the passthrough rewrite —
 * everything else in `claude-token.ts` was deleted (no callers; replaced by `detect.ts`).
 */

import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { shell } from 'electron';
import { CLAUDE_OAUTH_CONFIG, getClaudeOAuthScopes } from '../../shared/lib/claude-oauth';
import { generatePKCE, generateState } from './oauth';

const {
  CALLBACK_PORTS: CLAUDE_OAUTH_CALLBACK_PORTS,
  CALLBACK_PATH: CLAUDE_OAUTH_CALLBACK_PATH,
  CLIENT_ID: CLAUDE_CLIENT_ID,
  AUTH_ENDPOINT: CLAUDE_AUTH_ENDPOINT,
  TOKEN_ENDPOINT: CLAUDE_TOKEN_ENDPOINT,
} = CLAUDE_OAUTH_CONFIG;

const OAUTH_CALLBACK_HEADERS = {
  'Content-Type': 'text/html',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function generateCallbackPage(success: boolean, message: string): string {
  const color = success ? '#10b981' : '#ef4444';
  const icon = success ? '✓' : '✗';
  return `<!DOCTYPE html>
<html>
<head>
  <title>${success ? 'Authentication Successful' : 'Authentication Failed'}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: #16213e;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .icon {
      font-size: 48px;
      color: ${color};
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 8px 0; font-size: 24px; }
    p { margin: 0; color: #888; }
    .close { margin-top: 20px; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${success ? 'Authentication Successful' : 'Authentication Failed'}</h1>
    <p>${message}</p>
    <p class="close">You can close this window and return to Frink.</p>
  </div>
  ${success ? '<script>setTimeout(() => window.close(), 2000);</script>' : ''}
</body>
</html>`;
}

type ClaudeOAuthResult = {
  success: boolean;
  token?: string;
  error?: string;
  authUrl?: string;
};

export function runClaudeOAuthBrowser(
  onStatus: (message: string, authUrl?: string) => void,
): Promise<ClaudeOAuthResult> {
  return new Promise((resolve) => {
    const pkce = generatePKCE();
    const state = generateState();

    let server: Server | null = null;
    let actualPort: number = CLAUDE_OAUTH_CALLBACK_PORTS[0];
    let redirectUri = `http://localhost:${actualPort}${CLAUDE_OAUTH_CALLBACK_PATH}`;
    let resolved = false;
    let portIndex = 0;

    const cleanup = () => {
      if (server) {
        server.close();
        server = null;
      }
    };

    const finish = (result: ClaudeOAuthResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ success: false, error: 'Authentication timed out. Please try again.' });
    }, 180000);

    const tryStartServer = () => {
      if (portIndex >= CLAUDE_OAUTH_CALLBACK_PORTS.length) {
        finish({
          success: false,
          error: 'All callback ports are in use. Please close other applications and try again.',
        });
        return;
      }

      actualPort = CLAUDE_OAUTH_CALLBACK_PORTS[portIndex];
      redirectUri = `http://localhost:${actualPort}${CLAUDE_OAUTH_CALLBACK_PATH}`;

      server = createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://localhost:${actualPort}`);

        if (url.pathname !== CLAUDE_OAUTH_CALLBACK_PATH) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, OAUTH_CALLBACK_HEADERS);
          res.end(generateCallbackPage(false, `Authorization error: ${error}`));
          finish({ success: false, error: `Authorization error: ${error}` });
          return;
        }

        if (returnedState !== state) {
          res.writeHead(200, OAUTH_CALLBACK_HEADERS);
          res.end(generateCallbackPage(false, 'State mismatch - possible CSRF attack'));
          finish({ success: false, error: 'State mismatch - possible CSRF attack' });
          return;
        }

        if (!code) {
          res.writeHead(200, OAUTH_CALLBACK_HEADERS);
          res.end(generateCallbackPage(false, 'No authorization code received'));
          finish({ success: false, error: 'No authorization code received' });
          return;
        }

        onStatus('Exchanging code for token...');

        try {
          const tokenParams = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CLAUDE_CLIENT_ID,
            code_verifier: pkce.verifier,
          });

          const tokenResponse = await fetch(CLAUDE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString(),
          });

          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            res.writeHead(200, OAUTH_CALLBACK_HEADERS);
            res.end(generateCallbackPage(false, `Token exchange failed (${tokenResponse.status})`));
            finish({ success: false, error: `Token exchange failed: ${errorText}` });
            return;
          }

          const tokenData = (await tokenResponse.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
          };

          res.writeHead(200, OAUTH_CALLBACK_HEADERS);
          res.end(generateCallbackPage(true, 'You are now authenticated with Claude.'));
          finish({ success: true, token: tokenData.access_token });
        } catch (err) {
          res.writeHead(200, OAUTH_CALLBACK_HEADERS);
          res.end(generateCallbackPage(false, 'Failed to exchange code for token'));
          finish({
            success: false,
            error: `Token exchange failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          });
        }
      });

      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          portIndex++;
          tryStartServer();
        } else {
          finish({ success: false, error: `Failed to start callback server: ${err.message}` });
        }
      });

      server.listen(actualPort, '127.0.0.1', () => {
        const authUrl = new URL(CLAUDE_AUTH_ENDPOINT);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', CLAUDE_CLIENT_ID);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', getClaudeOAuthScopes());
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('state', state);

        const authUrlString = authUrl.toString();
        onStatus('Opening browser for authentication...', authUrlString);

        shell.openExternal(authUrlString).catch((openErr) => {
          finish({
            success: false,
            error: `Failed to open browser: ${openErr.message}`,
            authUrl: authUrlString,
          });
        });

        onStatus('Waiting for authentication in browser...', authUrlString);
      });
    };

    tryStartServer();
  });
}
