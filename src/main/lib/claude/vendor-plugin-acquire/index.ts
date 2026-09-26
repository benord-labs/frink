/**
 * Vendor plugin acquisition (sc-1730): drive the bundled claude CLI's own
 * marketplace/install machinery (or an explicitly pinned repository package)
 * into a FRINK-OWNED root — never the user's
 * ~/.claude (a --scope user install would silently enable the plugin in their
 * terminal sessions, inverting provider-config-canonical-home). The acquired
 * payload is pin-verified against the catalog's recorded gitCommitSha before
 * anything consumes it, then handed to the hook-stripped staging installer.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { VendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import { getBundledClaudeBinaryPath } from '../env';
import { readInstalledSha } from '../session-config-dir';
import { frinkUserHome } from '../../platform/frink-home';

const execFileAsync = promisify(execFile);

export type AcquireExec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type AcquireResult =
  | { ok: true; sourceDir: string; marketplaceDir: string }
  | { ok: false; reason: string };

const ACQUIRE_STEP_TIMEOUT_MS = 120_000;

// OUTSIDE the canonical ~/.frink/plugins root on purpose: the scratch holds an
// un-stripped payload plus a CLI install record that ENABLES it, so no future
// cache-dir env var aimed at the canonical root can ever reach it.
function acquireRoot(): string {
  return path.join(frinkUserHome(), '.frink', 'plugin-acquire');
}

/** Delete a plugin's acquisition residue once the payload has been copied out. */
export function cleanupAcquiredPayload(pin: VendorPluginPin): void {
  fs.rmSync(path.join(acquireRoot(), 'plugins', 'cache', pin.marketplace, pin.name), {
    recursive: true,
    force: true,
  });
}

/**
 * Fetch pin.name@pin.marketplace through `claude plugin marketplace add` +
 * `claude plugin install`, isolated via CLAUDE_CONFIG_DIR (scratch — the
 * user's settings never change) and CLAUDE_CODE_PLUGIN_CACHE_DIR (the frink
 * acquire root). Fail-closed on a gitCommitSha mismatch with the catalog pin:
 * the payload is deleted and never staged.
 */
export async function acquireVendorClaudePlugin(
  pin: VendorPluginPin,
  exec: AcquireExec = execFileAsync,
  root: string = acquireRoot(),
): Promise<AcquireResult> {
  if (pin.acquisition === 'repository') return acquireRepositoryPlugin(pin, exec, root);
  const pluginsDir = path.join(root, 'plugins');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsDir,
  };
  const bin = getBundledClaudeBinaryPath();
  const pluginId = `${pin.name}@${pin.marketplace}`;
  try {
    await exec(bin, ['plugin', 'marketplace', 'add', pin.sourceRepo], {
      env,
      timeout: ACQUIRE_STEP_TIMEOUT_MS,
    });
    await exec(bin, ['plugin', 'install', pluginId], {
      env,
      timeout: ACQUIRE_STEP_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `claude plugin acquisition failed: ${String(error)}`,
    };
  }

  return readAcquiredVendorPlugin(pin, root);
}

/** Reuse only a complete isolated acquisition whose receipt matches the current immutable pin. */
function readAcquiredVendorPlugin(pin: VendorPluginPin, root: string): AcquireResult {
  const pluginsDir = path.join(root, 'plugins');
  const pluginId = `${pin.name}@${pin.marketplace}`;
  const installedSha = readInstalledSha(pluginsDir, pluginId);
  const sourceDir = path.join(pluginsDir, 'cache', pin.marketplace, pin.name, pin.version);
  if (installedSha !== pin.gitCommitSha) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    return {
      ok: false,
      reason: `pin mismatch: acquired ${installedSha ?? 'unknown'}, catalog pins ${pin.gitCommitSha}`,
    };
  }
  const marketplaceDir = path.join(pluginsDir, 'marketplaces', pin.marketplace);
  if (
    !fs.existsSync(sourceDir) ||
    !fs.existsSync(path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'))
  ) {
    return {
      ok: false,
      reason: 'acquired payload incomplete (cache or marketplace missing)',
    };
  }
  return { ok: true, sourceDir, marketplaceDir };
}

/** A full pinned package absent from its vendor marketplace still uses the same canonical installer. */
async function acquireRepositoryPlugin(
  pin: VendorPluginPin,
  exec: AcquireExec,
  root: string,
): Promise<AcquireResult> {
  const cache = path.join(root, 'plugins', 'cache', pin.marketplace, pin.name);
  fs.mkdirSync(cache, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(cache, 'repository-'));
  const repository = path.join(scratch, 'git');
  const sourceDir = path.join(scratch, 'payload');
  const marketplaceDir = path.join(scratch, 'catalog');
  const archive = path.join(scratch, 'payload.tar');
  const options = { env: process.env, timeout: ACQUIRE_STEP_TIMEOUT_MS };
  try {
    await exec('git', ['init', '--bare', repository], options);
    await exec(
      'git',
      [
        '-C',
        repository,
        'fetch',
        '--depth=1',
        `https://github.com/${pin.payloadRepo}.git`,
        pin.gitCommitSha,
      ],
      options,
    );
    const revision = await exec('git', ['-C', repository, 'rev-parse', 'FETCH_HEAD'], options);
    if (revision.stdout.trim() !== pin.gitCommitSha) throw new Error('Revision mismatch');
    await exec(
      'git',
      [
        '-C',
        repository,
        'archive',
        '--format=tar',
        `--output=${archive}`,
        `${pin.gitCommitSha}${pin.payloadPath ? ':' + pin.payloadPath : ''}`,
      ],
      options,
    );
    fs.mkdirSync(sourceDir);
    await exec('tar', ['-xf', archive, '-C', sourceDir], options);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sourceDir, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    if (manifest.name !== pin.name || manifest.version !== pin.version)
      throw new Error('Package identity mismatch');
    // Runtime discovery metadata is a Frink projection, never an alteration to vendor bytes.
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: pin.marketplace,
        owner: { name: 'Frink' },
        plugins: [
          {
            name: pin.name,
            version: pin.version,
            source: { source: 'github', repo: pin.payloadRepo, ref: pin.gitCommitSha },
          },
        ],
      }),
    );
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    return { ok: true, sourceDir, marketplaceDir };
  } catch {
    fs.rmSync(scratch, { recursive: true, force: true });
    return { ok: false, reason: 'Could not acquire and verify the pinned official package.' };
  }
}
