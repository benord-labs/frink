#!/usr/bin/env node

// Stages Cursor's macOS platform package for both Mac archs, since bun installs only the host's.
// Version and sha512 come from bun.lock; the mac build copies resources/cursor-sdk/darwin-<arch>.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUrl } from './http-download.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.join(path.dirname(SCRIPT_PATH), '..', '..');
const STAGE_DIR = path.join(ROOT_DIR, 'resources', 'cursor-sdk');
const MAC_KEYS = ['darwin-arm64', 'darwin-x64'];

/** The version and sha512 integrity bun.lock pins for `@cursor/sdk-<key>`. */
export function lockedPlatformPackage(lockText, key) {
  const name = `@cursor/sdk-${key}`;
  const line = lockText.split('\n').find((l) => l.trimStart().startsWith(`"${name}": [`));
  const match = line?.match(/@(\d[^"]*)", .*"(sha512-[^"]+)"\]/);
  if (!match) throw new Error(`bun.lock has no pinned ${name}`);
  return { name, version: match[1], integrity: match[2] };
}

/** Download, verify and unpack one platform package into `<destRoot>/<key>`. */
export async function stagePlatformPackage(key, { lockText, destRoot, fetchTarball = fetchUrl }) {
  const { name, version, integrity } = lockedPlatformPackage(lockText, key);
  const url = `https://registry.npmjs.org/${name}/-/sdk-${key}-${version}.tgz`;
  const tarball = await fetchTarball(url);
  const actual = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
  if (actual !== integrity) throw new Error(`${name}@${version} does not match bun.lock`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-cursor-sdk-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.tgz'), tarball);
    const dest = path.join(destRoot, key);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', [
      '-xzf',
      path.join(tmp, 'package.tgz'),
      '-C',
      dest,
      '--strip-components=1',
    ]);
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const lockText = fs.readFileSync(path.join(ROOT_DIR, 'bun.lock'), 'utf8');
  for (const key of MAC_KEYS) {
    console.log(`Staged ${await stagePlatformPackage(key, { lockText, destRoot: STAGE_DIR })}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
