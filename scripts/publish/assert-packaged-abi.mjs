#!/usr/bin/env node
/**
 * Publish gate: assert every native module PACKAGED under release/ was compiled for
 * Electron's ABI — and, for mac slices, for the app's CPU arch — before anything uploads.
 *
 * Why the packaged bytes and not node_modules: the test gate legitimately flips
 * node_modules/better-sqlite3 to system Node's ABI (scripts/native-abi.mjs), so any
 * pre-build check races the writers of that file. The app.asar.unpacked payload is the
 * exact bytes users receive, inspected at the one choke point every publish path ends in
 * (local `bun run release` and CI's per-OS legs both run upload-to-r2.mjs).
 * Shipped incident: 0.0.10's DMGs carried better_sqlite3.node at Node's ABI 127 where
 * Electron needs 148 — the app died on first boot — and the x64 app carried an arm64
 * binary, so the Intel build could never load sqlite at all.
 *
 * Detector: a version-locked (NAN / direct-V8) module embeds its ABI as a
 * `node_register_module_v<N>` symbol; NAPI modules embed no marker and load on any ABI.
 * Scanning for the marker therefore needs no module allowlist. The multi-platform
 * `prebuilds/` trees (node-pty, bcrypt) are NAPI, so they never reach the arch check.
 *
 * Since better-sqlite3 was replaced by Node's built-in `node:sqlite`, the healthy bundle
 * contains ZERO version-locked modules — the gate stays to stop any future native dep
 * from reintroducing the 0.0.10 failure mode unnoticed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

/** CPU arch names in a Mach-O buffer (thin or fat), or null when not Mach-O. */
export function machoArchs(buf) {
  if (buf.length < 8) return null;
  const name = (cputype) =>
    cputype === CPU_ARM64 ? 'arm64' : cputype === CPU_X86_64 ? 'x86_64' : `cpu-${cputype}`;
  const magicBE = buf.readUInt32BE(0);
  // Fat/universal header is big-endian: 0xcafebabe (20-byte entries) / 0xcafebabf (32-byte).
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const entrySize = magicBE === 0xcafebabe ? 20 : 32;
    const count = buf.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < count; i++) archs.push(name(buf.readUInt32BE(8 + i * entrySize)));
    return archs;
  }
  const magicLE = buf.readUInt32LE(0);
  // Thin header, little-endian on disk: 0xfeedfacf (64-bit) / 0xfeedface (32-bit).
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) return [name(buf.readUInt32LE(4))];
  return null;
}

/** Distinct ABI numbers a version-locked module declares; empty for NAPI modules. */
export function abiMarkers(buf) {
  const found = buf.toString('latin1').match(/node_register_module_v(\d+)/g) ?? [];
  return [...new Set(found.map((m) => Number(m.slice('node_register_module_v'.length))))];
}

/** The arch an electron-builder mac output dir packages, or null when arch is not asserted. */
export function expectedArchForDir(relPath) {
  const top = relPath.split('/')[0];
  if (top === 'mac') return 'x86_64';
  if (top === 'mac-arm64') return 'arm64';
  return null; // mac-universal is fat (both slices pass); win/linux dirs are not Mach-O.
}

function collectNodeFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectNodeFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith('.node')) out.push(path);
  }
  return out;
}

function electronAbi() {
  const { version } = JSON.parse(readFileSync('./node_modules/electron/package.json', 'utf8'));
  // Transitive dep of @electron/rebuild — present wherever the rebuild path is.
  return import('node-abi').then(({ getAbi }) => Number(getAbi(version, 'electron')));
}

/**
 * Scan every .node under releaseDir; throw when a version-locked module targets the
 * wrong ABI or sits in a mac app dir of the wrong arch. Zero version-locked modules is
 * the expected healthy state (all current natives are NAPI).
 */
export async function assertPackagedAbi(releaseDir, { expectedAbi } = {}) {
  const abi = expectedAbi ?? (await electronAbi());
  const errors = [];
  let locked = 0;
  for (const file of collectNodeFiles(releaseDir)) {
    const rel = relative(releaseDir, file);
    const buf = readFileSync(file);
    const abis = abiMarkers(buf);
    if (abis.length === 0) continue; // NAPI — loads on any ABI.
    locked++;
    if (abis.some((v) => v !== abi)) {
      errors.push(
        `${rel}: compiled for NODE_MODULE_VERSION ${abis.join(',')}, Electron needs ${abi}`,
      );
    }
    const wantArch = expectedArchForDir(rel);
    const archs = machoArchs(buf);
    if (wantArch && archs && !archs.includes(wantArch)) {
      errors.push(`${rel}: Mach-O arch [${archs.join(',')}] missing required ${wantArch}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`[assert-packaged-abi] REFUSING TO PUBLISH:\n  ${errors.join('\n  ')}`);
  }
  console.log(`[assert-packaged-abi] OK — ${locked} version-locked module(s) at ABI ${abi}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertPackagedAbi(process.argv[2] ?? 'release').catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
