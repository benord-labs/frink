#!/usr/bin/env node

/**
 * Downloads Claude Code native binaries for bundling with the Electron app.
 *
 * Usage:
 *   node scripts/binaries/download-claude-binary.mjs  # Download for current platform
 *   node scripts/binaries/download-claude-binary.mjs --all  # Download all platforms
 *   node scripts/binaries/download-claude-binary.mjs --version 2.1.5  # Specific version
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingLiterals, REQUIRED_CLAUDE_BINARY_ENV } from './binary-capabilities.mjs';
import { downloadToFile, fetchUrl, sha256File } from './http-download.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const BIN_DIR = path.join(ROOT_DIR, 'resources', 'bin');

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

/**
 * Get latest version from GCS bucket
 */
async function getLatestVersion() {
  console.log('Fetching latest Claude Code version...');

  try {
    // Fetch from the same endpoint that install.sh uses
    const response = await fetch(
      'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest',
    );
    if (response.ok) {
      const version = await response.text();
      return version.trim();
    }
  } catch (error) {
    console.warn(`Failed to fetch latest version: ${error.message}`);
  }

  // Fallback floor: must support provider-native Auto Mode for SDK/non-Anthropic gateway use,
  // every `--effort` level in the catalog, and every catalog model. Auto's gateway opt-in is
  // reliable from 2.1.207, xhigh from 2.1.173; `claude-opus-5-5` first ships in 2.1.280.
  return '2.1.280';
}

/**
 * Download binary for a specific platform
 */
async function downloadPlatform(version, platformKey, manifest) {
  const platform = PLATFORMS[platformKey];
  if (!platform) {
    console.error(`Unknown platform: ${platformKey}`);
    return false;
  }

  const targetDir = path.join(BIN_DIR, platformKey);
  const targetPath = path.join(targetDir, platform.binary);

  // Create directory
  fs.mkdirSync(targetDir, { recursive: true });

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

  // Check if already downloaded with correct hash
  if (fs.existsSync(targetPath)) {
    const existingHash = calculateSha256(targetPath);
    if (existingHash === expectedHash) {
      // Capability-check the CACHED binary too: a hash match only proves it is the file the
      // manifest names, not that it supports the env var frink's auth model depends on.
      if (!rejectIfMissingCapability(targetPath)) return false;
      console.log(`  Already downloaded and verified`);
      return true;
    }
    console.log(`  Existing file has wrong hash, re-downloading...`);
  }

  // Download
  await downloadFile(downloadUrl, targetPath);

  // Verify hash
  const actualHash = calculateSha256(targetPath);
  if (actualHash !== expectedHash) {
    console.error(`  Hash mismatch!`);
    console.error(`    Expected: ${expectedHash}`);
    console.error(`    Actual:   ${actualHash}`);
    fs.unlinkSync(targetPath);
    return false;
  }
  console.log(`  Verified SHA256: ${actualHash.substring(0, 16)}...`);

  if (!rejectIfMissingCapability(targetPath)) return false;

  // Make executable (Unix)
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }

  console.log(`  Saved to: ${targetPath}`);
  return true;
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
  console.error(`    Pin a known-good version with --version= and open an issue.`);
  fs.unlinkSync(targetPath);
  return false;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const downloadAll = args.includes('--all');
  const versionArg = args.find((a) => a.startsWith('--version='));
  const specifiedVersion = versionArg?.split('=')[1];

  console.log('Claude Code Binary Downloader');
  console.log('=============================\n');

  // Get version
  const version = specifiedVersion || (await getLatestVersion());
  console.log(`Version: ${version}`);

  // Fetch manifest
  const manifestUrl = `${DIST_BASE}/${version}/manifest.json`;
  console.log(`Fetching manifest: ${manifestUrl}`);

  let manifest;
  try {
    manifest = await fetchJson(manifestUrl);
  } catch (error) {
    console.error(`Failed to fetch manifest: ${error.message}`);
    process.exit(1);
  }

  // Determine which platforms to download
  let platformsToDownload;
  if (downloadAll) {
    platformsToDownload = Object.keys(PLATFORMS);
  } else {
    // Current platform only
    const currentPlatform = `${process.platform}-${process.arch}`;
    if (!PLATFORMS[currentPlatform]) {
      console.error(`Unsupported platform: ${currentPlatform}`);
      console.log(`Supported platforms: ${Object.keys(PLATFORMS).join(', ')}`);
      process.exit(1);
    }
    platformsToDownload = [currentPlatform];
  }

  console.log(`\nPlatforms to download: ${platformsToDownload.join(', ')}`);

  // Create bin directory
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Write version file
  fs.writeFileSync(path.join(BIN_DIR, 'VERSION'), `${version}\n${new Date().toISOString()}\n`);

  // Download each platform
  let success = true;
  for (const platform of platformsToDownload) {
    const result = await downloadPlatform(version, platform, manifest);
    if (!result) success = false;
  }

  if (success) {
    console.log('\n✓ All downloads completed successfully!');
  } else {
    console.error('\n✗ Some downloads failed');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
