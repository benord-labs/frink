/* eslint-disable max-lines, max-lines-per-function */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';
import { shell } from 'electron';

// Regex constants
const MCP_SUFFIX_REGEX = /(mcp|sse)\/?$/;
const TRAILING_SLASHES_REGEX = /\/+$/;

export type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
};

/** Fetch OAuth metadata from the server's well-known endpoint; null if unsupported. `signal` cancels a slow fetch. */
export async function fetchOAuthMetadata(
  mcpBaseUrl: string,
  signal?: AbortSignal,
): Promise<OAuthMetadata | null> {
  try {
    const origin = new URL(mcpBaseUrl).origin;
    const metadataUrl = `${origin}/.well-known/oauth-authorization-server`;
    const response = await fetch(metadataUrl, { signal });
    if (response.ok) {
      return (await response.json()) as OAuthMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

export type OAuthConfig = {
  mcpBaseUrl: string; // e.g., http://localhost:3000/v1/links/abc123
  redirectUri?: string; // Optional custom redirect URI for deeplinks
  // RFC 8707 Resource Indicator — binds the access token's audience to this
  // resource URI. Required for some MCPs (e.g., Cloudflare's mcp.cloudflare.com)
  // whose downstream tool calls check the token `aud` claim.
  resource?: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
};

export type OAuthCallbacks = {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
};

const CALLBACK_PORT = 8914;
const CALLBACK_PATH = '/callback';
const CLIENT_NAME = 'frink';
const FALLBACK_CLIENT_NAME = 'Codex';

/**
 * Generate a styled OAuth callback page with the app's auth-result treatment.
 */
function generateOAuthPage(options: {
  title: string;
  message: string;
  isSuccess: boolean;
  autoClose?: boolean;
  errorDetail?: string;
}): string {
  const { title, isSuccess, autoClose = false, errorDetail } = options;

  // Terminal output line type
  type TerminalLine = {
    text: string;
    status?: string;
    statusClass?: string;
    isHighlight?: boolean;
    highlightColor?: 'green' | 'red';
    hasCursor?: boolean;
    isError?: boolean;
  };

  // Terminal output lines based on success/error
  const terminalLines: TerminalLine[] = isSuccess
    ? [
        { text: 'initiating handshake sequence...' },
        { text: 'verifying credentials', status: '[PROCESSING]', statusClass: 'status-wait' },
        { text: 'token exchange completed', status: '[OK]', statusClass: 'status-ok' },
        { text: 'AUTHORIZATION SUCCESSFUL', isHighlight: true, highlightColor: 'green' },
        { text: 'closing connection', hasCursor: true },
      ]
    : [
        { text: 'initiating handshake sequence...' },
        { text: 'verifying credentials', status: '[PROCESSING]', statusClass: 'status-wait' },
        { text: 'token exchange failed', status: '[ERROR]', statusClass: 'status-error' },
        { text: 'AUTHORIZATION FAILED', isHighlight: true, highlightColor: 'red' },
        ...(errorDetail ? [{ text: `error: ${errorDetail}`, isError: true }] : []),
      ];

  const terminalLinesHtml = terminalLines
    .map((line, i) => {
      let content: string = '';
      if (line.isHighlight) {
        const color = line.highlightColor === 'green' ? 'var(--green)' : 'var(--red)';
        const glow =
          line.highlightColor === 'green' ? 'rgb(134 239 172 / 0.4)' : 'rgb(252 165 165 / 0.4)';
        content = `<span class="cmd-text" style="color: ${color}; text-shadow: 0 0 10px ${glow};">${line.text}</span>`;
      } else if (line.isError) {
        content = `<span class="cmd-text" style="color: var(--red);">${line.text}</span>`;
      } else {
        content = `<span class="cmd-text">${line.text}${line.status ? ` <span class="${line.statusClass}">${line.status}</span>` : ''}${line.hasCursor ? ' <span class="cursor"></span>' : ''}</span>`;
      }
      return `        <div class="line" style="animation-delay: ${0.2 + i * 0.4}s;">
          <span class="prompt">➜</span>
          <span class="path">~</span>
          ${content}
        </div>`;
    })
    .join('\n');

  const progressSection = autoClose
    ? `
      <div class="progress-section">
        <div class="timer-info">
          <span>Session Autokill</span>
          <span id="countdown-text">3.0s</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
      </div>`
    : '';

  const autoCloseScript = autoClose
    ? `
    // Countdown Logic
    setTimeout(() => {
      const duration = 3000;
      const start = Date.now();
      const progressFill = document.getElementById('progress-fill');
      const countdownText = document.getElementById('countdown-text');

      const tick = () => {
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, duration - elapsed);
        const percent = Math.min(100, (elapsed / duration) * 100);

        if(progressFill) progressFill.style.width = percent + '%';
        if(countdownText) countdownText.textContent = (remaining / 1000).toFixed(1) + 's';

        if (elapsed < duration) {
          requestAnimationFrame(tick);
        } else {
          window.close();
        }
      };

      requestAnimationFrame(tick);
    }, 2200);`
    : '';

  const logoColor = isSuccess ? 'var(--primary)' : 'var(--red)';
  const logoGlow = isSuccess ? 'rgb(167 139 250 / 0.3)' : 'rgb(252 165 165 / 0.3)';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Frink - ${title}</title>
  <style>
    :root {
      --bg: #050505;
      --bg-dark: #0A0A0A;
      --bg-lighter: #141414;
      --fg: #E8E8E8;
      --comment: #8B8B8B;
      --primary: #A78BFA;
      --secondary: #7DF0A8;
      --blue: var(--primary);
      --cyan: #67E8F9;
      --green: #86EFAC;
      --magenta: var(--primary);
      --red: #FCA5A5;
      --yellow: #FDE68A;
      --orange: #F1B265;
      --terminal-black: #2D2D2D;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      width: 100vw;
      height: 100vh;
      background-color: var(--bg);
      background-image:
        radial-gradient(120% 95% at 92% 92%, color-mix(in srgb, var(--primary) 6%, transparent) 0%, transparent 52%),
        radial-gradient(140% 60% at 50% 108%, color-mix(in srgb, var(--secondary) 3%, transparent) 0%, transparent 45%),
        radial-gradient(90% 75% at 6% 10%, rgb(255 255 255 / 0.045) 0%, transparent 46%),
        radial-gradient(64% 52% at 80% 4%, rgb(255 255 255 / 0.035) 0%, transparent 50%),
        linear-gradient(180deg, rgb(255 255 255 / 0.04) 0%, transparent 22%);
      color: var(--fg);
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }

    .terminal-window {
      width: 90%;
      max-width: 850px;
      height: 70vh;
      min-height: 500px;
      background: rgb(20 20 20 / 0.95);
      border: 1px solid var(--terminal-black);
      box-shadow:
        0 0 40px rgba(0, 0, 0, 0.6),
        0 0 10px rgba(0, 0, 0, 0.4),
        0 0 0 1px rgb(167 139 250 / 0.05);
      border-radius: 6px;
      position: relative;
      z-index: 10;
      display: flex;
      flex-direction: column;
      animation: bootUp 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      overflow: hidden;
      backdrop-filter: blur(4px);
    }

    .title-bar {
      background: var(--bg-lighter);
      border-bottom: 1px solid var(--terminal-black);
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }

    .title-text {
      color: var(--comment);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .window-controls {
      display: flex;
      gap: 8px;
    }

    .control {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      position: relative;
    }
    .control.close { background: var(--red); }
    .control.minimize { background: var(--yellow); }
    .control.maximize { background: var(--green); }

    .content {
      padding: 30px;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow-y: auto;
    }

    .meta-info {
      width: 100%;
      text-align: left;
      font-size: 12px;
      color: var(--comment);
      margin-bottom: 30px;
      border-bottom: 1px dashed var(--terminal-black);
      padding-bottom: 15px;
      opacity: 0.8;
    }

    .logo-container {
      margin-bottom: 30px;
      width: 100%;
      display: flex;
      justify-content: center;
      overflow-x: auto;
      padding-bottom: 10px;
    }

    .logo {
      color: ${logoColor};
      font-weight: 700;
      font-size: 12px;
      line-height: 1;
      white-space: pre;
      text-align: left;
      text-shadow: 0 0 15px ${logoGlow};
      letter-spacing: normal;
    }

    .terminal-output {
      width: 100%;
      max-width: 600px;
      text-align: left;
      font-size: 14px;
      line-height: 1.8;
    }

    .line {
      display: flex;
      gap: 12px;
      margin-bottom: 6px;
      opacity: 0;
      animation: typeLine 0.1s forwards;
    }

    .prompt { color: var(--magenta); font-weight: bold; }
    .path { color: var(--blue); }
    .cmd-text { color: var(--fg); text-shadow: 0 0 2px rgb(232 232 232 / 0.2); }

    .status-ok { color: var(--green); font-weight: bold; }
    .status-wait { color: var(--yellow); }
    .status-error { color: var(--red); font-weight: bold; }
    .highlight { color: var(--cyan); }

    .cursor {
      display: inline-block;
      width: 8px;
      height: 1.2em;
      background: var(--fg);
      vertical-align: sub;
      margin-left: 8px;
      opacity: 0;
    }

    .line:last-child .cursor {
      animation: blink 1s step-end infinite, appear 0.1s forwards 2.2s;
    }

    .progress-section {
      margin-top: 40px;
      width: 100%;
      max-width: 450px;
      opacity: 0;
      animation: fadeIn 0.5s forwards 2.0s;
    }

    .progress-bar {
      height: 2px;
      background: var(--bg-lighter);
      margin-top: 10px;
      position: relative;
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      background: var(--green);
      box-shadow: 0 0 15px var(--green);
    }

    .timer-info {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--comment);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Mobile Responsive Styles */
    @media (max-width: 640px) {
      body {
        align-items: flex-start;
        padding-top: 0;
        background-color: var(--bg-dark);
      }

      .terminal-window {
        width: 100%;
        height: 100vh;
        max-width: none;
        border-radius: 0;
        border: none;
        box-shadow: none;
      }

      .title-bar {
        padding: 12px 15px;
      }

      .content {
        padding: 20px 15px;
        justify-content: flex-start;
      }

      .logo {
        font-size: 2.2vw;
        align-self: center;
      }

      @media (max-width: 400px) {
        .logo { font-size: 1.9vw; }
      }

      .terminal-output {
        font-size: 12px;
        margin-top: 20px;
      }

      .meta-info {
        margin-bottom: 20px;
        font-size: 10px;
      }
    }

    @keyframes bootUp {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes typeLine {
      from { opacity: 0; transform: translateX(-4px); }
      to { opacity: 1; transform: translateX(0); }
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    @keyframes appear { to { opacity: 1; } }
    @keyframes fadeIn { to { opacity: 1; } }

  </style>
</head>
<body>
  <div class="terminal-window">
    <div class="title-bar">
      <div class="window-controls">
        <div class="control close"></div>
        <div class="control minimize"></div>
        <div class="control maximize"></div>
      </div>
      <div class="title-text">
        user@frink-auth-cli ~
      </div>
      <div style="width: 48px;"></div>
    </div>

    <div class="content">
      <div class="meta-info">
        Last login: <span id="login-time">...</span> on ttys003
      </div>

      <div class="logo-container">
<pre class="logo"></pre>
      </div>

      <div class="terminal-output">
${terminalLinesHtml}
      </div>
${progressSection}
    </div>
  </div>

  <script>
    // Set Login Time
    const now = new Date();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const timeString = days[now.getDay()] + ' ' + months[now.getMonth()] + ' ' + now.getDate() + ' ' + now.toTimeString().split(' ')[0];
    document.getElementById('login-time').textContent = timeString;
${autoCloseScript}
  </script>
</body>
</html>`;
}

// Generate PKCE code verifier and challenge
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Generate random state for CSRF protection
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * RFC 8707 Resource Indicator: absolute URI, no fragment.
 * Returns canonical `href` for authorization and token requests.
 */
export function validateOAuthResourceIndicator(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('OAuth resource (RFC 8707) must be a non-empty absolute URI');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('OAuth resource (RFC 8707) must be a valid absolute URI');
  }
  if (parsed.hash !== '') {
    throw new Error('OAuth resource (RFC 8707) must not include a fragment');
  }
  return parsed.href;
}

export class CraftOAuth {
  private config: OAuthConfig;
  private server: Server | null = null;
  private callbacks: OAuthCallbacks;

  constructor(config: OAuthConfig, callbacks: OAuthCallbacks) {
    this.callbacks = callbacks;
    this.config = {
      ...config,
      resource: config.resource ? validateOAuthResourceIndicator(config.resource) : undefined,
    };
  }

  // Get OAuth server metadata
  private async getServerMetadata(): Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
  }> {
    const metadataUrl = `${this.config.mcpBaseUrl}/.well-known/oauth-authorization-server`;

    const response = await fetch(metadataUrl);
    if (!response.ok) {
      throw new Error(`Failed to get OAuth metadata: ${response.status}`);
    }

    return response.json() as Promise<{
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
    }>;
  }

  /**
   * Register OAuth client with allowlist fallback.
   * Tries CLIENT_NAME first, falls back to FALLBACK_CLIENT_NAME if rejected.
   */
  private async registerClientWithFallback(
    registrationEndpoint: string,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    this.callbacks.onStatus(`Registering client as '${CLIENT_NAME}'...`);
    try {
      const client = await this.registerClient(registrationEndpoint, CLIENT_NAME);
      this.callbacks.onStatus(`Registered as client: ${client.client_id}`);
      return { clientId: client.client_id, clientSecret: client.client_secret };
    } catch {
      this.callbacks.onStatus(
        `Registration as '${CLIENT_NAME}' failed, trying '${FALLBACK_CLIENT_NAME}'...`,
      );
      const client = await this.registerClient(registrationEndpoint, FALLBACK_CLIENT_NAME);
      this.callbacks.onStatus(`Registered as client: ${client.client_id}`);
      return { clientId: client.client_id, clientSecret: client.client_secret };
    }
  }

  // Register OAuth client dynamically
  private async registerClient(
    registrationEndpoint: string,
    clientName: string,
  ): Promise<{
    client_id: string;
    client_secret?: string;
  }> {
    const redirectUri =
      this.config.redirectUri || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // Public client
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register OAuth client: ${error}`);
    }

    return response.json() as Promise<{
      client_id: string;
      client_secret?: string;
    }>;
  }

  // Exchange authorization code for tokens
  private async exchangeCodeForTokens(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    clientId: string,
    redirectUri?: string,
    clientSecret?: string,
  ): Promise<OAuthTokens> {
    const uri =
      redirectUri || this.config.redirectUri || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: uri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    if (clientSecret) {
      params.set('client_secret', clientSecret);
    }
    if (this.config.resource) {
      // RFC 8707 — echo the resource on the token request so the server can
      // audience-bind the access token.
      params.set('resource', this.config.resource);
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Refresh access token
  async refreshAccessToken(refreshToken: string, clientId: string): Promise<OAuthTokens> {
    const metadata = await this.getServerMetadata();

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (this.config.resource) {
      params.set('resource', this.config.resource);
    }

    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Check if the MCP server requires OAuth
  async checkAuthRequired(): Promise<boolean> {
    const metadataUrl = `${this.config.mcpBaseUrl}/.well-known/oauth-authorization-server`;
    this.callbacks.onStatus('Checking if authentication is required...');

    try {
      const response = await fetch(metadataUrl);
      if (response.ok) {
        this.callbacks.onStatus('OAuth required - server has OAuth metadata');
        return true;
      }
      // 404 or other error means no OAuth
      this.callbacks.onStatus('No OAuth metadata found - server may be public');
      return false;
    } catch (_error) {
      this.callbacks.onStatus('Could not reach OAuth metadata - assuming public');
      return false;
    }
  }

  // Start the OAuth flow
  async authenticate(): Promise<{ tokens: OAuthTokens; clientId: string }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');

    // Get server metadata
    let metadata: OAuthMetadata;
    try {
      metadata = await this.getServerMetadata();
      this.callbacks.onStatus(`Found OAuth endpoints at ${this.config.mcpBaseUrl}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to get OAuth metadata: ${msg}`);
      throw error;
    }

    // Register client if endpoint available
    let clientId: string;
    if (metadata.registration_endpoint) {
      const reg = await this.registerClientWithFallback(metadata.registration_endpoint);
      clientId = reg.clientId;
    } else {
      // Use a default client ID for public clients
      clientId = 'craft-agent';
      this.callbacks.onStatus(`Using default client ID: ${clientId}`);
    }

    // Generate PKCE and state
    const pkce = generatePKCE();
    const state = generateState();
    const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
    this.callbacks.onStatus('Generated PKCE challenge and state');

    // Build authorization URL
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (this.config.resource) {
      authUrl.searchParams.set('resource', this.config.resource);
    }

    // Start local server to receive callback
    this.callbacks.onStatus(`Starting callback server on port ${CALLBACK_PORT}...`);
    const codePromise = this.startCallbackServer(state);

    // Open browser for authorization
    this.callbacks.onStatus('Opening browser for authorization...');
    await shell.openExternal(authUrl.toString());

    // Wait for the authorization code
    this.callbacks.onStatus('Waiting for you to authorize in browser...');
    const authCode = await codePromise;
    this.callbacks.onStatus('Authorization code received!');

    // Exchange code for tokens
    this.callbacks.onStatus('Exchanging authorization code for tokens...');
    const tokens = await this.exchangeCodeForTokens(
      metadata.token_endpoint,
      authCode,
      pkce.verifier,
      clientId,
    );
    this.callbacks.onStatus('Tokens received successfully!');

    return { tokens, clientId };
  }

  /**
   * Start OAuth flow without waiting for callback (for deeplink-based flows)
   * Returns the authorization URL and state/verifier for later token exchange
   * @param preloadedMetadata - Optional pre-fetched OAuth metadata to avoid duplicate fetch
   */
  async startAuthFlow(preloadedMetadata?: OAuthMetadata): Promise<{
    authUrl: string;
    state: string;
    codeVerifier: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
  }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');
    const metadata = preloadedMetadata || (await this.getServerMetadata());

    // Register client if endpoint available
    let clientId: string;
    let clientSecret: string | undefined;
    if (metadata.registration_endpoint) {
      const reg = await this.registerClientWithFallback(metadata.registration_endpoint);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    } else {
      clientId = 'frink';
    }

    const pkce = generatePKCE();
    const state = generateState();
    const redirectUri =
      this.config.redirectUri || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (this.config.resource) {
      authUrl.searchParams.set('resource', this.config.resource);
    }

    return {
      authUrl: authUrl.toString(),
      state,
      codeVerifier: pkce.verifier,
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      clientSecret,
    };
  }

  /**
   * Complete OAuth flow by exchanging code for tokens (called after deeplink callback)
   */
  async completeAuthFlow(
    code: string,
    codeVerifier: string,
    tokenEndpoint: string,
    clientId: string,
    clientSecret?: string,
  ): Promise<OAuthTokens> {
    const redirectUri =
      this.config.redirectUri || `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
    return this.exchangeCodeForTokens(
      tokenEndpoint,
      code,
      codeVerifier,
      clientId,
      redirectUri,
      clientSecret,
    );
  }

  // Start local HTTP server to receive OAuth callback
  private startCallbackServer(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopServer();
        reject(new Error('OAuth timeout - no callback received'));
      }, 300000); // 5 minute timeout

      this.server = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

        if (url.pathname === CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              generateOAuthPage({
                title: 'Authorization Failed',
                message: 'You can close this window.',
                isSuccess: false,
                errorDetail: error,
              }),
            );
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              generateOAuthPage({
                title: 'Security Error',
                message: 'State mismatch - possible CSRF attack.',
                isSuccess: false,
              }),
            );
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(
              generateOAuthPage({
                title: 'Authorization Failed',
                message: 'No authorization code received.',
                isSuccess: false,
              }),
            );
            clearTimeout(timeout);
            this.stopServer();
            reject(new Error('No authorization code'));
            return;
          }

          // Success!
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            generateOAuthPage({
              title: 'Authorization Successful',
              message: 'You can close this window and return to the terminal.',
              isSuccess: true,
              autoClose: true,
            }),
          );

          clearTimeout(timeout);
          this.stopServer();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      this.server.listen(CALLBACK_PORT, () => {
        // Server started
      });

      this.server.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start callback server: ${err.message}`));
      });
    });
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // Cancel the OAuth flow
  cancel(): void {
    this.stopServer();
  }
}

// Helper to extract the base MCP URL from a full MCP URL
export function getMcpBaseUrl(mcpUrl: string): string {
  // Remove /mcp or /sse suffix if present, then strip any trailing slashes so
  // callers can safely append `/.well-known/...` without producing `//`.
  return mcpUrl.replace(MCP_SUFFIX_REGEX, '').replace(TRAILING_SLASHES_REGEX, '');
}
