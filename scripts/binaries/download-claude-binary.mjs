#!/usr/bin/env node

/**
 * Downloads Claude Code native binaries for bundling with the Electron app.
 *
 * Usage:
 *   node scripts/binaries/download-claude-binary.mjs  # Pinned version, current platform
 *   node scripts/binaries/download-claude-binary.mjs --all  # Pinned version, all platforms
 *   node scripts/binaries/download-claude-binary.mjs --version=2.1.5  # Manual trial only
 *
 * The pin lives in claude-cli-version.json; a CLI bump is a one-line change there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingLiterals, REQUIRED_CLAUDE_BINARY_ENV } from './binary-capabilities.mjs';
import { downloadToFile, fetchUrl, sha256File } from './http-download.mjs';
import { installStaged, stagingPath, sweepStaging, writeFileAtomic } from './install-file.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_PATH);
const ROOT_DIR = path.join(__dirname, '..', '..');
const BIN_DIR = path.join(ROOT_DIR, 'resources', 'bin');
const PIN_PATH = path.join(__dirname, 'claude-cli-version.json');

// Claude Code distribution base URL
const DIST_BASE =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';

// Platform mappings
const PLATFORMS = {
  'darwin-arm64': { dir: 'darwin-arm64', binary: 'claude' },
  'darwin-x64': { dir: 'darwin-x64', binary: 'claude' },
  'linux-arm64': { dir: 'linux-arm64', binary: 'claude' },
  'linux-x64': { dir: 'linux-x64', binary: 'claude' },
  'win32-x64': { dir: 'win32-x64', binary: 'claude.exe' },
};

/** Fetch + parse JSON from a URL (redirect-following; see ./http-download). */
const fetchJson = (url) => fetchUrl(url, { json: true });

/** Download a file to destPath with a throttled progress line (redirect-following). */
function downloadFile(url, destPath) {
  let lastPercent = 0;
  return downloadToFile(url, destPath, {
    onProgress: (percent) => {
      if (percent !== lastPercent && percent % 10 === 0) {
        process.stdout.write(`\r  Progress: ${percent}%`);
        lastPercent = percent;
      }
    },
  }).then(() => {
    process.stdout.write('\r  Progress: 100%\n');
  });
}

/** SHA-256 hex of a file (see ./http-download). */
const calculateSha256 = sha256File;

/** The committed Claude CLI version every release and CI build ships. */
export function readPinnedVersion(pinPath = PIN_PATH) {
  const { version } = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`${pinPath} must pin a plain X.Y.Z version, got ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Download binary for a specific platform.
 *
 * The live binary is never written in place: macOS caches a signed Mach-O's code signature per
 * vnode, so a truncate-and-rewrite gets every later exec SIGKILLed. The new file is staged in
 * `binDir` (outside the packaged per-platform dir), verified there, then renamed over the target.
 */
export async function downloadPlatform(
  version,
  platformKey,
  manifest,
  { binDir = BIN_DIR, download = downloadFile } = {},
) {
  const platform = PLATFORMS[platformKey];
  if (!platform) {
    console.error(`Unknown platform: ${platformKey}`);
    return false;
  }

  const targetDir = path.join(binDir, platformKey);
  const targetPath = path.join(targetDir, platform.binary);

  // Create directory
  fs.mkdirSync(targetDir, { recursive: true });
  sweepStaging(binDir, platform.binary);

  // Get expected hash from manifest
  const platformManifest = manifest.platforms[platform.dir];
  if (!platformManifest) {
    console.error(`No manifest entry for ${platform.dir}`);
    return false;
  }

  const expectedHash = platformManifest.checksum;
  const downloadUrl = `${DIST_BASE}/${version}/${platform.dir}/${platform.binary}`;

  console.log(`\nDownloading Claude Code for ${platformKey}...`);
  console.log(`  URL: ${downloadUrl}`);
  console.log(`  Size: ${(platformManifest.size / 1024 / 1024).toFixed(1)} MB`);

  const staged = stagingPath(binDir, platform.binary);
  try {
    // Check if already downloaded with correct hash
    if (fs.existsSync(targetPath)) {
      const existingHash = calculateSha256(targetPath);
      if (existingHash === expectedHash) {
        // Capability-check the CACHED binary too: a hash match only proves it is the file the
        // manifest names, not that it supports the env var frink's auth model depends on.
        if (!rejectIfMissingCapability(targetPath)) return false;
        // Re-link at a fresh inode: a binary an older version of this script rewrote in place
        // has the right bytes but is still SIGKILLed, and this heals it. Skipped on Windows, which
        // has no such cache and refuses to replace an executable that is running.
        if (process.platform !== 'win32') {
          fs.copyFileSync(targetPath, staged, fs.constants.COPYFILE_FICLONE);
          installStaged(staged, targetPath, { mode: 0o755 });
        }
        console.log(`  Already downloaded and verified`);
        return true;
      }
      console.log(`  Existing file has wrong hash, re-downloading...`);
    }

    await download(downloadUrl, staged);

    // Verify hash
    const actualHash = calculateSha256(staged);
    if (actualHash !== expectedHash) {
      console.error(`  Hash mismatch!`);
      console.error(`    Expected: ${expectedHash}`);
      console.error(`    Actual:   ${actualHash}`);
      return false;
    }
    console.log(`  Verified SHA256: ${actualHash.substring(0, 16)}...`);

    if (!rejectIfMissingCapability(staged)) return false;

    installStaged(staged, targetPath, { mode: 0o755 });
    console.log(`  Saved to: ${targetPath}`);
    return true;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

/**
 * Reject (and delete) a binary missing an env var Frink's auth model depends on. Shared by the
 * cached and freshly-downloaded paths so a stale cache can never smuggle an unsupported binary in.
 */
function rejectIfMissingCapability(targetPath) {
  const missing = findMissingLiterals(targetPath, REQUIRED_CLAUDE_BINARY_ENV);
  if (missing.length === 0) return true;
  console.error(`  Missing capability: ${missing.join(', ')}`);
  if (missing.includes('CLAUDE_SECURESTORAGE_CONFIG_DIR')) {
    console.error(
      `    Frink spawns agents with an isolated CLAUDE_CONFIG_DIR and relies on this env var`,
    );
    console.error(
      `    to point the CLI at the canonical keychain login so it can refresh its own token.`,
    );
    console.error(
      `    Without it every agent would need a frozen injected token and would 401 the moment`,
    );
    console.error(`    anything else on the machine rotates the credential.`);
  }
  if (missing.some((name) => name.endsWith('_FILE_DESCRIPTOR'))) {
    console.error(`    Frink hands stored credentials to the CLI through a pipe (fd 3) so the`);
    console.error(`    agent's Bash commands and MCP servers never inherit them in their env.`);
    console.error(`    Without it an api-key or setup-token account cannot authenticate.`);
  }
  console.error(`    Pin a known-good version in claude-cli-version.json and open an issue.`);
  fs.unlinkSync(targetPath);
  return false;
}

/** The version and platforms one run downloads, from its arguments and the machine it runs on. */
export function downloadPlan(args, currentPlatform = `${process.platform}-${process.arch}`) {
  const trialVersion = args.find((arg) => arg.startsWith('--version='))?.split('=')[1];
  const version = trialVersion || readPinnedVersion();
  if (args.includes('--all')) return { version, platforms: Object.keys(PLATFORMS) };
  if (!PLATFORMS[currentPlatform]) {
    const supported = Object.keys(PLATFORMS).join(', ');
    throw new Error(`Unsupported platform: ${currentPlatform} (supported: ${supported})`);
  }
  return { version, platforms: [currentPlatform] };
}

async function main() {
  console.log('Claude Code Binary Downloader');
  console.log('=============================\n');
  const { version, platforms } = downloadPlan(process.argv.slice(2));
  console.log(`Version: ${version}`);

  const manifestUrl = `${DIST_BASE}/${version}/manifest.json`;
  console.log(`Fetching manifest: ${manifestUrl}`);
  const manifest = await fetchJson(manifestUrl).catch((error) => {
    throw new Error(`Failed to fetch manifest: ${error.message}`);
  });

  console.log(`\nPlatforms to download: ${platforms.join(', ')}`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  let success = true;
  for (const platform of platforms) {
    if (!(await downloadPlatform(version, platform, manifest))) success = false;
  }
  if (!success) {
    console.error('\n✗ Some downloads failed');
    process.exit(1);
  }
  // Written last, and only when every binary landed: the app reads VERSION at runtime to gate
  // CLI flags, so it must never describe a binary that is not there.
  writeFileAtomic(path.join(BIN_DIR, 'VERSION'), `${version}\n${new Date().toISOString()}\n`);
  console.log('\n✓ All downloads completed successfully!');
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
