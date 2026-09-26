#!/usr/bin/env node
/**
 * Bootstrap gate: put the Electron binary on disk deliberately.
 *
 * electron@43 ships NO install lifecycle script (its package.json has no "scripts" key), so
 * `bun install` legitimately leaves node_modules/electron as a JS shell with no dist/ or path.txt.
 * index.js ends `module.exports = getElectronPath()`, which fetches the ~120MB binary lazily from
 * whichever process first requires electron — and throws "Electron failed to install correctly"
 * when that fetch fails, arbitrarily far from the cause. Making it an explicit bootstrap step
 * matches how this repo already handles large platform binaries (claude:download / codex:download).
 *
 * Idempotent twice over: we skip the spawn when the binary is already resolvable, and electron's
 * own install.js early-exits via isInstalled().
 *
 * Callers: `dev`, the QA rig (scripts/qa/boot.sh), build-desktop.yml before its
 * Electron smoke step, and `bun run electron:download` by hand. NOT `package:*` — electron-builder
 * fetches its own dist through @electron/get and never reads node_modules/electron/dist.
 *
 * The binary is NOT needed to run the test suite: vitest pins ELECTRON_OVERRIDE_DIST_PATH so no
 * test process can reach the real module.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ELECTRON_DIR = join(ROOT, 'node_modules', 'electron');

/**
 * Resolve the binary exactly the way electron's own getElectronPath() does: read path.txt, then
 * confirm dist/<that path> is really there. Checking dist/ alone would read a half-extracted
 * download as success and make every later run a false no-op.
 */
export function electronBinaryPath(electronDir = ELECTRON_DIR, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  const pathFile = join(electronDir, 'path.txt');
  if (!exists(pathFile)) return null;
  const relative = String(read(pathFile, 'utf-8')).trim();
  if (!relative) return null;
  const full = join(electronDir, 'dist', relative);
  return exists(full) ? full : null;
}

/**
 * Ensure the binary exists, running electron's installer at most once. Throws with both the cause
 * and the remedy — a silent failure here is the whole defect this script exists to remove.
 */
export function ensureElectronBinary(deps = {}) {
  const electronDir = deps.electronDir ?? ELECTRON_DIR;
  const exists = deps.existsSync ?? existsSync;
  const log = deps.log ?? console.log;
  const resolveBinary = () => electronBinaryPath(electronDir, deps);

  if (!exists(electronDir)) {
    throw new Error(
      `[ensure-electron-binary] ${electronDir} is missing — run \`bun install\` before this script.`,
    );
  }

  const existing = resolveBinary();
  if (existing) {
    log(`[ensure-electron-binary] already installed: ${existing}`);
    return { status: 'present', binaryPath: existing };
  }

  const installer = join(electronDir, 'install.js');
  if (!exists(installer)) {
    throw new Error(
      `[ensure-electron-binary] ${installer} is missing — node_modules/electron looks corrupt; ` +
        'delete it and re-run `bun install`.',
    );
  }

  log(
    '[ensure-electron-binary] Electron binary absent — downloading (~120MB, cached per version)…',
  );
  const runInstall =
    deps.runInstall ??
    (() => execFileSync(process.execPath, [installer], { stdio: 'inherit', cwd: electronDir }));
  try {
    runInstall();
  } catch (error) {
    throw new Error(
      `[ensure-electron-binary] electron's installer failed: ${error.message}\n` +
        '  The binary is fetched from GitHub releases — check network/proxy, then re-run ' +
        '`bun run electron:download`.',
    );
  }

  const installed = resolveBinary();
  if (!installed) {
    throw new Error(
      '[ensure-electron-binary] installer reported success but no binary is resolvable — ' +
        'delete node_modules/electron and re-run `bun install && bun run electron:download`.',
    );
  }
  log(`[ensure-electron-binary] installed: ${installed}`);
  return { status: 'installed', binaryPath: installed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    ensureElectronBinary();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
