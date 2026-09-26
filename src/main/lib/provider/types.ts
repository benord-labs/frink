/**
 * Provider spine — shared types (PCH-1).
 *
 * Implements the epic `provider-config-canonical-home` (Target #2, 2026-06-08,
 * docs/decisions/): Frink owns canonical config in `~/.frink` and bridges it
 * across the big-5 coding CLIs via TWO VERBS — DELIVER data + ENFORCE rules.
 * A per-provider {@link CapabilityDescriptor} drives data-driven dispatch
 * (LSP-style negotiation); adding a 6th provider is a DATA ROW, not new code.
 */

/** The big-5 coding CLIs Frink bridges config across. */
export type ProviderType = 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'opencode';

/**
 * How a single capability category reaches a given provider.
 *
 * - `inject`   — in-memory injection at spawn (e.g. Claude SDK `mcpServers`); zero files.
 * - `copy`     — byte/translated file-copy into the provider's machine-local config.
 * - `file`     — written as the provider's declarative rule-file (e.g. hooks).
 * - `advisory` — best-effort only; degrades to a coarse flag + warning (no host veto).
 * - `enforce`  — hard-enforced at the provider's permission gate (e.g. canUseTool).
 * - `none`     — not bridged; stays native to the provider.
 */
export type CapabilityMode = 'inject' | 'copy' | 'file' | 'advisory' | 'enforce' | 'none';

/**
 * Per-provider capability row. Each category names the mechanism by which that
 * kind of config follows the user to this provider. `deliver`/`enforce` dispatch
 * off these modes; the switch-time probe reads them to make the do-it-well-or-not
 * promise. See the decision log for the verified mechanism per category.
 */
export type CapabilityDescriptor = {
  /** MCP servers (data). */
  mcp: CapabilityMode;
  /** Skills / SKILL.md bundles (data). */
  skills: CapabilityMode;
  /** Slash commands (data). */
  commands: CapabilityMode;
  /** Sub-agent brain: name/description/system-prompt/model (data). */
  agentBrain: CapabilityMode;
  /** Sub-agent tool-allowlist (rule). */
  allowlist: CapabilityMode;
  /** Lifecycle hooks (rule). */
  hooks: CapabilityMode;
  /** Plugin bundles (proprietary per-tool wrapper; stays native). */
  plugins: CapabilityMode;
};

/** Capability category keys — the addressable surface of {@link CapabilityDescriptor}. */
export type CapabilityCategory = keyof CapabilityDescriptor;

/**
 * Dispatch outcome status. `noop` while a category's handler is a stub or the
 * mode doesn't apply; `enforced` = an enforce-check ran and PASSED; `denied` =
 * an enforce-check ran and the call must be blocked (the gate turns this into
 * the host deny).
 */
type DispatchStatus = 'noop' | 'delivered' | 'enforced' | 'denied';

/** Outcome of a single `deliver()`/`enforce()` dispatch. */
export type DispatchResult = {
  category: CapabilityCategory;
  mode: CapabilityMode;
  status: DispatchStatus;
  detail?: string;
};

/** Result of a switch-time capability probe. */
export type ProbeResult = {
  /** Whether Frink can make any bridging promise for this provider. */
  supported: boolean;
  /** The capability row dispatch will run against. */
  descriptor: CapabilityDescriptor;
  /** Human-readable reason — populated when `supported` is false. */
  reason?: string;
};
