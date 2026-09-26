import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import { z } from 'zod';
import {
  type VendorPluginPin,
  vendorPluginPinByName,
} from '../../../../shared/integrations/vendor-plugin-pins';
import {
  canonicalPayloadDir,
  claudeProjectionDir,
  codexProjectionDir,
  marketplaceCatalogDir,
  pluginTierDirs,
  vendorPluginsRoot,
} from './layout';
import { frinkUserHome } from '../../platform/frink-home';

export { codexProjectionDir } from './layout';

/** Staged vendor plugins with their claude-code projection paths, for the delivery probe. */
export function listStagedVendorPluginProjections(): Array<{
  id: string;
  projectionDir: string;
}> {
  return listStagedVendorPlugins().map((p) => ({
    id: p.id,
    projectionDir: claudeProjectionDir(p),
  }));
}

/** Portable skills use the hook-stripped projection, whether the vendor ships a Codex wrapper or only a Claude package. */
export function listStagedVendorPluginCodexSkillRoots(): string[] {
  return listStagedVendorPlugins().flatMap((p) => codexSkillRootsFor(codexProjectionDir(p)));
}

const codexManifestSkillsSchema = z.object({
  skills: z.union([z.string(), z.array(z.string())]).optional(),
});

function codexSkillRootsFor(projection: string): string[] {
  try {
    const codex = path.join(projection, '.codex-plugin', 'plugin.json');
    const native = fs.lstatSync(codex, { throwIfNoEntry: false }) !== undefined;
    const manifest = native ? codex : path.join(projection, '.claude-plugin', 'plugin.json');
    const root = fs.realpathSync(projection);
    if (!fs.realpathSync(manifest).startsWith(`${root}${path.sep}`)) return [];
    const declared = codexManifestSkillsSchema.parse(
      JSON.parse(fs.readFileSync(manifest, 'utf-8')),
    ).skills;
    const paths =
      declared === undefined
        ? native
          ? []
          : ['./skills']
        : Array.isArray(declared)
          ? declared
          : [declared];
    return paths.flatMap((relative) => {
      if (path.isAbsolute(relative) || (native && !relative.startsWith('./'))) return [];
      // A skill root is a directory below the projection: the projection itself is not one.
      const dir = path.resolve(projection, relative);
      if (!dir.startsWith(`${path.resolve(projection)}${path.sep}`) || !fs.existsSync(dir))
        return [];
      const real = fs.realpathSync(dir);
      return real.startsWith(`${root}${path.sep}`) && fs.statSync(dir).isDirectory() ? [dir] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Read the CLI-recorded gitCommitSha for a plugin id from a plugins dir's
 * installed_plugins.json — null on any deviation, which callers treat as a
 * pin mismatch (fail closed). Shared by the local-cache fast path and the
 * acquisition fallback so both verify with identical semantics.
 */
export function readInstalledSha(pluginsDir: string, pluginId: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8');
    // SAFETY: file is written by the claude CLI in its documented v2 shape;
    // only one entry's gitCommitSha is read; any deviation returns null.
    const parsed = JSON.parse(raw) as {
      plugins?: Record<string, Array<{ gitCommitSha?: string }>>;
    };
    return parsed.plugins?.[pluginId]?.[0]?.gitCommitSha ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vendor plugins (provider-config-rationale §5, N→1→N: frink absorbs into
// ~/.frink as the CANONICAL runtime-agnostic source, then projects out
// per-provider). The canonical store keeps the acquired package VERBATIM —
// hooks and every runtime wrapper (.claude-plugin, .codex-plugin) intact as
// inert data. Each runtime gets its own DERIVED projection, HOOK-STRIPPED
// (hooks are enforced, never delivered): claude-code's is what chat sessions
// load via $CLAUDE_CONFIG_DIR/plugins + enabledPlugins; codex's skills are
// handed to the app-server as extra skill roots (sc-1731). Because every
// delivered tier is hook-stripped, staging is safe for unattended runs too.
// ---------------------------------------------------------------------------

export type StagedVendorPlugin = {
  /** `name@marketplace` — the CLI's plugin id and enabledPlugins key. */
  id: string;
  marketplace: string;
  name: string;
  version: string;
  gitCommitSha: string;
  /** Marketplace git repo (`owner/name`) recorded for known_marketplaces.json. */
  sourceRepo: string;
  installedAt: string;
};

function stagedManifestPath(): string {
  return path.join(vendorPluginsRoot(), 'staged.json');
}

const stagedManifestSchema = z.object({
  plugins: z.array(
    z.object({
      id: z.string(),
      marketplace: z.string(),
      name: z.string(),
      version: z.string(),
      gitCommitSha: z.string(),
      sourceRepo: z.string(),
      installedAt: z.string(),
    }),
  ),
});

/** Any shape writeStagedManifest would not have produced reads as "nothing staged" — never a throw. */
function parseStagedManifest(raw: string): StagedVendorPlugin[] {
  const parsed = stagedManifestSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data.plugins : [];
}

export function listStagedVendorPlugins(): StagedVendorPlugin[] {
  try {
    return parseStagedManifest(fs.readFileSync(stagedManifestPath(), 'utf-8'));
  } catch {
    return [];
  }
}

/** Async twin for request-serving paths (composer scan, plugins.list) so the main loop never blocks. */
async function readStagedVendorPlugins(): Promise<StagedVendorPlugin[]> {
  try {
    return parseStagedManifest(await fs.promises.readFile(stagedManifestPath(), 'utf-8'));
  } catch {
    return [];
  }
}

type VettedStagedPlugin = { pin: VendorPluginPin; entry: StagedVendorPlugin };

/**
 * Staged entries that equal a compiled-in pin in marketplace, version and sha, paired with that pin.
 * Consumers derive every path from the PIN, so a tampered or stale (pin-bumped) entry selects nothing.
 */
export async function readVettedStagedPlugins(): Promise<VettedStagedPlugin[]> {
  const vetted: VettedStagedPlugin[] = [];
  for (const entry of await readStagedVendorPlugins()) {
    const pin = vendorPluginPinByName(entry.name);
    if (
      pin &&
      pin.marketplace === entry.marketplace &&
      pin.version === entry.version &&
      pin.gitCommitSha === entry.gitCommitSha
    ) {
      vetted.push({ pin, entry });
    }
  }
  return vetted;
}

/** Write-then-rename: a concurrent async reader sees the old manifest or the new one, never a torn file. */
function writeStagedManifest(plugins: StagedVendorPlugin[]): void {
  fs.mkdirSync(vendorPluginsRoot(), { recursive: true });
  const tmp = `${stagedManifestPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ plugins }, null, 2));
  fs.renameSync(tmp, stagedManifestPath());
}

/**
 * Copy a plugin package excluding every hook surface: a root-level `hooks`
 * dir/file never crosses, and the manifest's `hooks` key is deleted. This is
 * the structural HOOKS-ARE-ENFORCED-NEVER-DELIVERED guarantee — the staged
 * payload physically carries no native hook policy.
 */
function copyPluginPayloadHookStripped(sourceDir: string, targetDir: string): void {
  swapInto(targetDir, (tmpDir) => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name === 'hooks' || COPY_EXCLUSIONS.has(entry.name)) continue;
      fs.cpSync(path.join(sourceDir, entry.name), path.join(tmpDir, entry.name), {
        recursive: true,
      });
    }
    // Both runtime manifests carry a hooks surface (codex accepts path,
    // path-list, inline, and inline-list forms — key deletion covers them all).
    for (const wrapper of ['.claude-plugin', '.codex-plugin']) {
      const manifestPath = path.join(tmpDir, wrapper, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      // SAFETY: plugin.json is a JSON object by the plugin spec; only the
      // top-level `hooks` key is read/deleted — the runtime object keeps every
      // other key intact for re-serialisation.
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        hooks?: unknown;
      };
      if ('hooks' in manifest) {
        delete manifest.hooks;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
    }
  });
}

// .in_use is CLI runtime state (live PID markers), not package content.
const COPY_EXCLUSIONS = new Set(['.git', '.in_use']);

/**
 * Build a directory in a sibling tmp and swap it in, so a concurrent reader
 * never observes a missing or half-copied tree (a live CLI session may hold
 * the projection open).
 */
function swapInto(targetDir: string, build: (tmpDir: string) => void): void {
  const tmpDir = `${targetDir}.tmp-${process.pid}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  build(tmpDir);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, targetDir);
}

/**
 * Copy a package verbatim into the canonical store — hooks and every runtime
 * wrapper intact as inert data (the store is not executed; projections are).
 */
function copyPluginPayloadVerbatim(sourceDir: string, targetDir: string): void {
  swapInto(targetDir, (tmpDir) => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (COPY_EXCLUSIONS.has(entry.name)) continue;
      fs.cpSync(path.join(sourceDir, entry.name), path.join(tmpDir, entry.name), {
        recursive: true,
      });
    }
  });
}

/**
 * Install a vendor plugin: verbatim canonical copy, the claude-code
 * projection (hook-stripped — future runtimes add sibling projections from
 * the same canonical payload), a marketplace catalog mirror (the CLI's loader
 * resolves plugin source + version through it), and a staged.json upsert.
 * Callers own WHAT to install (plugin lifecycle); this owns representation.
 */
export function installVendorPlugin(input: {
  sourceDir: string;
  marketplaceDir: string;
  plugin: Omit<StagedVendorPlugin, 'id' | 'installedAt'>;
}): StagedVendorPlugin {
  const { marketplace, name } = input.plugin;
  const id = `${name}@${marketplace}`;
  // The store is keyed by name alone (sc-2805): only the vetted pin may own a name, and
  // vendor-plugin-pins.test.ts keeps pin names unique, so two marketplaces can never collide.
  if (vendorPluginPinByName(name)?.marketplace !== marketplace) {
    throw new Error(
      `vendor plugin ${id} is not the vetted pin for "${name}"; the store is name-keyed`,
    );
  }
  // Idempotent re-install: same pin already materialised means no filesystem
  // work — a repeat "Add plugin" must never rebuild a projection a live chat
  // session has open.
  const existing = listStagedVendorPlugins().find((p) => p.id === id);
  if (
    existing &&
    existing.version === input.plugin.version &&
    existing.gitCommitSha === input.plugin.gitCommitSha &&
    fs.existsSync(canonicalPayloadDir(input.plugin)) &&
    fs.existsSync(claudeProjectionDir(input.plugin)) &&
    fs.existsSync(codexProjectionDir(input.plugin))
  ) {
    return existing;
  }
  copyPluginPayloadVerbatim(input.sourceDir, canonicalPayloadDir(input.plugin));
  copyPluginPayloadHookStripped(
    canonicalPayloadDir(input.plugin),
    claudeProjectionDir(input.plugin),
  );
  copyPluginPayloadHookStripped(
    canonicalPayloadDir(input.plugin),
    codexProjectionDir(input.plugin),
  );
  const catalogSource = path.join(input.marketplaceDir, '.claude-plugin', 'marketplace.json');
  // claude-code marketplace catalog (claude CLI format) — a codex projection
  // needs its own catalog representation, so the mirror nests per-runtime.
  const catalogTarget = path.join(marketplaceCatalogDir(marketplace), '.claude-plugin');
  fs.mkdirSync(catalogTarget, { recursive: true });
  fs.copyFileSync(catalogSource, path.join(catalogTarget, 'marketplace.json'));

  const staged: StagedVendorPlugin = {
    ...input.plugin,
    id: `${input.plugin.name}@${marketplace}`,
    installedAt: new Date().toISOString(),
  };
  const others = listStagedVendorPlugins().filter((p) => p.id !== staged.id);
  writeStagedManifest([...others, staged]);
  return staged;
}

/**
 * Disable = drop the manifest entry ONLY. Payload + projection dirs stay, so
 * every consumer (session staging, delivery probe, inventory) sees the plugin
 * as absent while re-enable is a pure manifest re-insert — no re-acquisition.
 */
export function unstageVendorPlugin(id: string): void {
  writeStagedManifest(listStagedVendorPlugins().filter((p) => p.id !== id));
}

/**
 * Re-enable from dirs already on disk: re-insert the manifest entry after
 * verifying both tiers still exist for the PINNED version. A bumped pin or a
 * missing dir returns false — the caller falls back to full pin-verified
 * staging (which re-acquires if needed).
 */
export function restageVendorPlugin(pin: VendorPluginPin): boolean {
  const entry: StagedVendorPlugin = {
    id: `${pin.name}@${pin.marketplace}`,
    marketplace: pin.marketplace,
    name: pin.name,
    version: pin.version,
    gitCommitSha: pin.gitCommitSha,
    sourceRepo: pin.sourceRepo,
    installedAt: new Date().toISOString(),
  };
  if (
    !fs.existsSync(canonicalPayloadDir(entry)) ||
    !fs.existsSync(claudeProjectionDir(entry)) ||
    !fs.existsSync(codexProjectionDir(entry))
  ) {
    return false;
  }
  const staged = listStagedVendorPlugins().filter((p) => p.id !== entry.id);
  writeStagedManifest([...staged, entry]);
  return true;
}

/** Remove a pinned vendor plugin, including one disabled before removal: manifest, canonical payload, and every runtime projection. Marketplace mirrors stay — tiny and reusable. */
export function removeVendorPlugin(id: string): void {
  const staged = listStagedVendorPlugins();
  const target = vendorPluginPinByName(id.split('@')[0] ?? '');
  if (target && `${target.name}@${target.marketplace}` === id) {
    for (const dir of pluginTierDirs(target.name)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Keep the identity available for retry until every owned tier has been removed.
  writeStagedManifest(staged.filter((p) => p.id !== id));
}

/**
 * Build the staging root for a builtin's pinned vendor plugin from the
 * machine's local claude-code plugin cache. Same fail-closed contract as the
 * acquisition path: the cache's CLI-recorded gitCommitSha must equal the
 * catalog pin, or this returns false so the caller falls through to the
 * pin-verified acquisition — frink never records a sha it did not check.
 */
export function installVendorPluginFromLocalClaudeCache(pin: VendorPluginPin): boolean {
  const cacheRoot = path.join(frinkUserHome(), '.claude', 'plugins');
  const sourceDir = path.join(cacheRoot, 'cache', pin.marketplace, pin.name, pin.version);
  const marketplaceDir = path.join(cacheRoot, 'marketplaces', pin.marketplace);
  if (
    !fs.existsSync(sourceDir) ||
    !fs.existsSync(path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'))
  ) {
    log.info(
      `[claude] vendor plugin ${pin.name}@${pin.marketplace} not in the local plugin cache — staging skipped`,
    );
    return false;
  }
  const localSha = readInstalledSha(cacheRoot, `${pin.name}@${pin.marketplace}`);
  if (localSha !== pin.gitCommitSha) {
    log.info(
      `[claude] vendor plugin ${pin.name}@${pin.marketplace} local cache sha ${localSha ?? 'unknown'} does not match the catalog pin — falling back to verified acquisition`,
    );
    return false;
  }
  installVendorPlugin({ sourceDir, marketplaceDir, plugin: pin });
  return true;
}

export function stageVendorPluginsIntoConfigDir(isolatedConfigDir: string): void {
  const staged = listStagedVendorPlugins();
  const settingsPath = path.join(isolatedConfigDir, 'settings.json');
  if (staged.length === 0) {
    // Nothing staged: leave dirs untouched unless a previous projection must
    // be disabled — most sessions never get a settings.json at all.
    if (fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }, null, 2));
    }
    return;
  }
  const pluginsDir = path.join(isolatedConfigDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const installed = {
    version: 2,
    plugins: Object.fromEntries(
      staged.map((p) => [
        p.id,
        [
          {
            scope: 'user',
            // Sessions load the claude-code PROJECTION (hook-stripped),
            // never the canonical payload.
            installPath: claudeProjectionDir(p),
            version: p.version,
            installedAt: p.installedAt,
            gitCommitSha: p.gitCommitSha,
          },
        ],
      ]),
    ),
  };
  const marketplaces = Object.fromEntries(
    [...new Set(staged.map((p) => p.marketplace))].map((marketplace) => [
      marketplace,
      {
        source: {
          source: 'github',
          repo: staged.find((p) => p.marketplace === marketplace)?.sourceRepo,
        },
        installLocation: marketplaceCatalogDir(marketplace),
        lastUpdated: staged[0]?.installedAt,
      },
    ]),
  );
  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify(installed, null, 2),
  );
  fs.writeFileSync(
    path.join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify(marketplaces, null, 2),
  );
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      { enabledPlugins: Object.fromEntries(staged.map((p) => [p.id, true])) },
      null,
      2,
    ),
  );
}
