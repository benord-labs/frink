/**
 * Provider spine — capability map (PCH-1).
 *
 * Pure data + a safe lookup. Each row is the verified mechanism per category for
 * one provider (decision `provider-config-canonical-home`, Target #2). Adding a
 * provider is a DATA ROW here, not a new code path.
 *
 * SEED POLICY: `claude-code`, `cursor`, and `codex` are verified and carry real
 * modes; gemini/opencode stay all-`none` until their SDK/protocol gates are
 * verified (see TODO(PCH-8)).
 */

import type { CapabilityDescriptor, ProviderType } from './types';

/**
 * Verified default — used when a provider is unknown/unsupported.
 *
 * plugins `copy` — attended chat sessions load frink-catalog vendor plugins
 * from a HOOK-STRIPPED frink-owned root projected into the isolated config
 * dir (session-config-dir.ts). Native hook policy never crosses; unattended
 * runs stage no plugins (provider-config-canonical-home, 2026-08-24 note).
 */
const CLAUDE_CODE_DESCRIPTOR: CapabilityDescriptor = {
  mcp: 'inject',
  skills: 'copy',
  commands: 'copy',
  agentBrain: 'inject',
  allowlist: 'enforce',
  hooks: 'file',
  plugins: 'copy',
};

/**
 * Cursor: same data delivery, but no host veto → allowlist is advisory. Agent brains
 * reach Cursor as FILES (`~/.cursor/agents/*.md` — the CLI's native discovery); the
 * CLI spawn has no in-memory agents channel, so `copy` is the honest mode.
 */
const CURSOR_DESCRIPTOR: CapabilityDescriptor = {
  mcp: 'inject',
  skills: 'copy',
  commands: 'copy',
  agentBrain: 'copy',
  allowlist: 'advisory',
  hooks: 'file',
  plugins: 'none',
};

/**
 * OpenAI Codex, invoked as a PERSISTENT `codex app-server` process speaking JSON-RPC
 * (NOT `codex exec`). Verified against the cloned protocol source
 * (cloned-projects/codex/codex-rs/app-server-protocol). Decision `provider-config-canonical-home`.
 *
 * - mcp `inject`     — `mcp_servers` is a config table; the runner injects servers per-startup via
 *                      `--config mcp_servers.<name>...` overrides (no file copy). Like Claude's SDK channel.
 * - skills `copy`    — skills load as files under `~/.agents/skills` (ext/skills host roots, User
 *                      scope; `~/.codex/skills` is codex's deprecated back-compat location).
 * - commands `none`  — the app-server exposes no user-command channel (skills only, via `skills/extraRoots/set`);
 *                      Frink expands slash commands to plain text before send (sc-2799), so nothing is copied.
 * - agentBrain `copy`— sub-agent roles load as `*.toml` FILES under `~/.codex/agents` (core agent_roles
 *                      discovery ignores `.md`); the app-server spawn has no in-memory agents channel, so
 *                      `copy` is the honest mode. Tool limits: read-only → sandbox_mode, others refused.
 * - allowlist `enforce` — THE WIN over `codex exec`: the app-server sends ExecCommandApproval /
 *                      ApplyPatchApproval JSON-RPC REQUESTS; the runner answers each with a `decision`
 *                      bound to Frink's permission gate (allowed→Accept, denied→Decline/Cancel). True host veto.
 * - hooks `none`     — codex HAS a `hooks` config layer (config.toml `[hooks]`), but mapping Frink's
 *                      hooks onto its declaration schema is UNVERIFIED. execpolicy `.rules` is a
 *                      command-prefix POLICY engine (allow/prompt/forbidden), NOT a lifecycle-hooks file —
 *                      so it is not the hooks mechanism. Promote to `file` only after verifying the hooks crate.
 * - plugins `inject` — staged vendor plugins' hook-stripped codex projections deliver their skills
 *                      per-startup via the native `skills/extraRoots/set` app-server RPC (sc-1731);
 *                      no file lands in the user's codex home. Plugin MCP/commands stay per-runtime:
 *                      the vendor's `.codex-plugin` manifest declares what codex gets.
 */
const CODEX_DESCRIPTOR: CapabilityDescriptor = {
  mcp: 'inject',
  skills: 'copy',
  commands: 'none',
  agentBrain: 'copy',
  allowlist: 'enforce',
  hooks: 'none',
  plugins: 'inject',
};

// TODO(PCH-8): verify gemini/opencode SDK + protocol gates, then replace these
// all-`none` placeholders with real modes. Until verified, refusing to claim a
// capability is the do-it-well-or-not-at-all guarantee.
const UNVERIFIED_DESCRIPTOR: CapabilityDescriptor = {
  mcp: 'none',
  skills: 'none',
  commands: 'none',
  agentBrain: 'none',
  allowlist: 'none',
  hooks: 'none',
  plugins: 'none',
};

/** The single source of truth the probe and dispatchers read. */
export const CAPABILITY_MAP: Record<ProviderType, CapabilityDescriptor> = {
  'claude-code': CLAUDE_CODE_DESCRIPTOR,
  cursor: CURSOR_DESCRIPTOR,
  codex: CODEX_DESCRIPTOR,
  // TODO(PCH-8): unverified — descriptors are placeholders.
  gemini: UNVERIFIED_DESCRIPTOR,
  opencode: UNVERIFIED_DESCRIPTOR,
};

/**
 * Look up a provider's capability row. An unknown / not-yet-mapped provider
 * falls back to the all-`none` UNVERIFIED descriptor — NOT claude-code — so a
 * forgotten map row (or a stale provider string) fails SAFE (bridges nothing,
 * probe reports unsupported) instead of silently behaving like Claude Code.
 * Edge-case hardening (PCH-1 review).
 */
export function getCapabilityDescriptor(provider: ProviderType): CapabilityDescriptor {
  return CAPABILITY_MAP[provider] ?? UNVERIFIED_DESCRIPTOR;
}
