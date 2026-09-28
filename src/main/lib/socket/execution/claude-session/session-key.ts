import crypto from 'node:crypto';
import stableStringify from 'fast-json-stable-stringify';
import { spawnCredentialFingerprint } from '../../../claude/credential-fd-spawn';

// Applied live to a running CLI, or only meaningful at spawn, so a change never needs a new CLI.
// `model` and the Ultra `settings` flag are set on a claimed CLI before its turn (plan-auto-approve).
const NON_KEY_OPTIONS = new Set([
  'permissionMode',
  'resume',
  'hooks',
  'canUseTool',
  'stderr',
  'model',
  'settings',
  // The credential pipe: keyed by the `credential` part instead, a function has no digest.
  'spawnClaudeCodeProcess',
]);

function digest(value: unknown): string {
  const json = stableStringify(value ?? null);
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

// Each CLI mints its own dynamic-chat channel token: identity, not configuration. The toolset in
// the same URL still keys the spawn.
function withoutChannel(mcpServers: Record<string, unknown> | undefined): unknown {
  const dynamicChat = mcpServers?.frink_dynamic_chat as { url?: string } | undefined;
  if (!dynamicChat?.url) return mcpServers;
  const url = dynamicChat.url.replace(/channel=[^&]*/, '');
  return { ...mcpServers, frink_dynamic_chat: { ...dynamicChat, url } };
}

/** Effort is set live too, except `max`: the live setting (`effortLevel`) has no max tier. */
export function effortKeyPart(effort: unknown): string {
  return digest(effort === 'max' ? 'max' : null);
}

/** One digest per spawn option, MCP servers, login and piped-credential fingerprint, so a mismatch
 * names its parts. The per-execute staged config path is left out of `extraArgs`. */
export function computeClaudeSessionKey(
  options: object,
  mcpServers: Record<string, unknown> | undefined,
  login?: string,
): Record<string, string> {
  const pipe = (options as { spawnClaudeCodeProcess?: unknown }).spawnClaudeCodeProcess;
  const keyParts: Record<string, string> = {
    mcpServers: digest(withoutChannel(mcpServers)),
    login: digest(login),
    credential: digest(spawnCredentialFingerprint(pipe)),
    effort: effortKeyPart((options as { effort?: unknown }).effort),
  };
  for (const [name, value] of Object.entries(options)) {
    if (NON_KEY_OPTIONS.has(name) || name === 'effort') continue;
    keyParts[name] = digest(
      name === 'extraArgs' ? { ...(value as object), 'mcp-config': undefined } : value,
    );
  }
  return keyParts;
}

/** Names of the parts that differ between two keys. Never their values: those carry credentials. */
export function diffKeyParts(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((name) => a[name] !== b[name]);
}
