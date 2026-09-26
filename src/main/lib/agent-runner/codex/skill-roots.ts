import crypto from 'node:crypto';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import { listStagedVendorPluginCodexSkillRoots } from '../../claude/session-config-dir';

/**
 * Vendor-plugin skill delivery for codex sessions (sc-1731). Codex loads the
 * hook-stripped projections' skill dirs through its native
 * `skills/extraRoots/set` app-server RPC; this module computes the roots and
 * a revision so staged-state changes (install/uninstall/disable/enable) alter
 * the app-server registry key and evict warm servers — the codex mirror of
 * Claude's stage-on-every-CLI-start semantics.
 */
export type CodexSkillRootsBinding = { extraSkillRoots: string[]; revision: string };

export function buildCodexSkillRootsBinding(
  vendorPluginsEnabled: boolean = LAUNCH_FLAGS.vendorClaudePlugins,
): CodexSkillRootsBinding {
  const extraSkillRoots = vendorPluginsEnabled
    ? [...listStagedVendorPluginCodexSkillRoots()].sort()
    : [];
  const revision = crypto
    .createHash('sha256')
    .update(JSON.stringify(extraSkillRoots))
    .digest('hex');
  return { extraSkillRoots, revision };
}

export type CodexSkillRootsRpcOutcome = { ok: boolean; error?: string };

let lastRpcOutcome: CodexSkillRootsRpcOutcome | null = null;

/**
 * Delivery is an RPC on a live process, so directory existence alone cannot
 * prove it happened — the plugins delivery probe reads this recorded outcome
 * instead of guessing from the filesystem.
 */
export function recordCodexSkillRootsRpcOutcome(outcome: CodexSkillRootsRpcOutcome): void {
  lastRpcOutcome = outcome;
}

/** Null = no codex app-server has attempted delivery since app start. */
export function getCodexSkillRootsRpcOutcome(): CodexSkillRootsRpcOutcome | null {
  return lastRpcOutcome;
}

/** Test-only: restore the pre-first-delivery state so test order doesn't matter. */
export function _resetCodexSkillRootsRpcOutcomeForTests(): void {
  lastRpcOutcome = null;
}
