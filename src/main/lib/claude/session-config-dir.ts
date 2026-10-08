import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { LAUNCH_FLAGS } from '../../../shared/launch-flags';
import { stageVendorPluginsIntoConfigDir } from './vendor-plugins';
import { frinkUserHome } from '../platform/frink-home';

/**
 * Report a staging failure. Staging degrades silently by design — a session simply runs without
 * the resource — so the capture is the only signal that it happened. Lazy import keeps
 * @sentry/electron out of this module's static graph, matching executor.ts's error paths.
 */
function captureStagingFailure(error: unknown, stage: string): void {
  void import('../sentry/init')
    .then(({ captureMainException }) => {
      captureMainException(error, {
        surface: 'claude-session-config-dir',
        stage,
      });
    })
    // Telemetry must never raise into a caller that is mid-recovery: a failed capture
    // would surface as an unhandled rejection instead of the staging failure it reports.
    .catch(() => {});
}

/** Cap for {@link configDirStaged}; oldest entry is evicted first. */
const MAX_STAGED_CACHE_SIZE = 1000;

/** Config dirs already staged, keyed by cacheKey. LRU via Map insertion order. */
const configDirStaged = new Map<string, true>();

/**
 * Stage the user's ~/.claude into an isolated CLAUDE_CONFIG_DIR so a spawned session still sees
 * their own resources: skills/ and agents/ are symlinked for SDK discovery at
 * $CLAUDE_CONFIG_DIR/skills/, and CLAUDE.md is copied because the CLI resolves User-tier memory
 * as $CLAUDE_CONFIG_DIR/CLAUDE.md — without it the user's global instructions apply in the
 * terminal but silently vanish inside Frink.
 *
 * Memory is COPIED, not symlinked (docs/decisions/provider-config-canonical-home.md), and re-copied
 * on EVERY call: the caller is about to spawn a CLI process, so a few KB of file copy is noise, and
 * memoising it would latch a chat to whatever its first turn saw. Only the symlink work is memoised
 * per cacheKey. An edit to ~/.claude/CLAUDE.md therefore lands at the next CLI start for that chat,
 * the same refresh point Claude Code itself uses.
 */
export function stageClaudeConfigDir(isolatedConfigDir: string, cacheKey: string): void {
  const homeClaudeDir = path.join(frinkUserHome(), '.claude');
  try {
    const userMemory = path.join(homeClaudeDir, 'CLAUDE.md');
    if (fs.existsSync(userMemory)) {
      fs.copyFileSync(userMemory, path.join(isolatedConfigDir, 'CLAUDE.md'));
    }
  } catch (error) {
    // Non-fatal — the session just runs without user memory. Captured because a silent
    // failure here reproduces the very bug this staging exists to fix: the user's global
    // instructions apply in the terminal but not in Frink, with nothing to show why.
    captureStagingFailure(error, 'memory');
  }

  // Every call, like memory: install/uninstall must land at the next CLI
  // start for this chat, so vendor-plugin projection is never memoised.
  stageVendorPluginsBestEffort(isolatedConfigDir);

  if (configDirStaged.has(cacheKey)) {
    // LRU touch — delete then set moves cacheKey to newest.
    configDirStaged.delete(cacheKey);
    configDirStaged.set(cacheKey, true);
    return;
  }
  try {
    let staged = true;
    for (const dir of ['skills', 'agents'] as const) {
      const source = path.join(homeClaudeDir, dir);
      const target = path.join(isolatedConfigDir, dir);
      if (fs.existsSync(source) && !fs.existsSync(target)) {
        try {
          fs.symlinkSync(source, target, 'dir');
        } catch (error) {
          staged = false;
          // Lost to a create race, or blocked by permissions — the session then runs
          // without that resource, so make the reason visible rather than guessing later.
          captureStagingFailure(error, dir);
        }
      }
    }
    if (configDirStaged.size >= MAX_STAGED_CACHE_SIZE) {
      const oldest = configDirStaged.keys().next().value;
      if (oldest !== undefined) {
        configDirStaged.delete(oldest);
        log.info(
          `[claude] config-dir staging eviction: removed oldest cacheKey=${oldest}, inserted cacheKey=${cacheKey} (max=${MAX_STAGED_CACHE_SIZE})`,
        );
      }
    }
    // Only a clean pass is memoised: marking a partial failure as staged would make the
    // early-return above permanent for this chat, so a symlink lost to a transient
    // condition could never be retried.
    if (staged) configDirStaged.set(cacheKey, true);
  } catch (error) {
    // Non-fatal — skills/agents just won't be discovered
    captureStagingFailure(error, 'staging');
  }
}

/** The hooks in ~/.claude/settings.json, which the isolated config dir hides; read at every spawn
 * like CLAUDE.md and passed through the SDK's settings option so Claude runs them natively. */
export function readUserHookSettings(): Pick<Settings, 'hooks' | 'disableAllHooks'> {
  const file = path.join(frinkUserHome(), '.claude', 'settings.json');
  const settings: Pick<Settings, 'hooks' | 'disableAllHooks'> = {};
  if (!fs.existsSync(file)) return settings;
  try {
    const { hooks, disableAllHooks }: Settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hooks) settings.hooks = hooks;
    if (disableAllHooks !== undefined) settings.disableAllHooks = disableAllHooks;
  } catch (error) {
    // Non-fatal: the session runs without the user's hooks, as Claude does with an unreadable file.
    captureStagingFailure(error, 'user-hooks');
  }
  return settings;
}

/**
 * Project the staged vendor plugins into one session's isolated config dir:
 * plugins/installed_plugins.json + plugins/known_marketplaces.json (absolute
 * paths into the frink-owned root) and settings.json enabledPlugins. Runs on
 * EVERY staging call (not memoised) so install/uninstall/disable lands at the
 * next CLI start. The settings.json frink writes carries ONLY enabledPlugins —
 * never permissions or hooks keys (provider-config-canonical-home).
 */
function stageVendorPluginsBestEffort(isolatedConfigDir: string): void {
  if (!LAUNCH_FLAGS.vendorClaudePlugins) return;
  try {
    stageVendorPluginsIntoConfigDir(isolatedConfigDir);
  } catch (error) {
    // Non-fatal — the session runs without vendor plugin tools.
    captureStagingFailure(error, 'vendor-plugins');
  }
}

/** Test-only: drop staging memoisation so test order doesn't matter. */
export function _resetConfigDirStagingForTests(): void {
  configDirStaged.clear();
}

// Vendor-plugin store API (extracted at the size ratchet; import paths are
// stable for every consumer and test mock via this re-export).
export {
  installVendorPlugin,
  installVendorPluginFromLocalClaudeCache,
  listStagedVendorPluginCodexSkillRoots,
  listStagedVendorPluginProjections,
  readInstalledSha,
  removeVendorPlugin,
  restageVendorPlugin,
  stageVendorPluginsIntoConfigDir,
  unstageVendorPlugin,
} from './vendor-plugins';
export { stagedVendorPluginInventory } from './vendor-plugins/inventory';
