import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abiMarkers,
  assertPackagedAbi,
  expectedArchForDir,
  machoArchs,
} from './assert-packaged-abi.mjs';

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;
const ELECTRON_ABI = 148;

// Hoisted per biome lint/performance/useTopLevelRegex.
const WRONG_ABI = /NODE_MODULE_VERSION 127, Electron needs 148/;
const WRONG_ARCH = /arch \[arm64\] missing required x86_64/;

/** A thin 64-bit Mach-O header for one CPU type. */
const thinMacho = (cputype) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype, 4);
  return b;
};

/** A fat (universal) Mach-O header whose entries carry the given CPU types. */
const fatMacho = (...cputypes) => {
  const b = Buffer.alloc(8 + cputypes.length * 20);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((t, i) => {
    b.writeUInt32BE(t, 8 + i * 20);
  });
  return b;
};

/** The ABI marker a version-locked (NAN) module embeds; NAPI modules have none. */
const marker = (abi) => Buffer.from(` node_register_module_v${abi} `);

describe('abiMarkers', () => {
  it('extracts and dedupes the declared ABI', () => {
    expect(abiMarkers(Buffer.concat([marker(127), marker(127)]))).toEqual([127]);
  });

  it('is empty for NAPI modules (no marker)', () => {
    expect(abiMarkers(Buffer.from('napi_register_module_v1'))).toEqual([]);
  });
});

describe('machoArchs', () => {
  it('reads a thin header', () => {
    expect(machoArchs(thinMacho(CPU_ARM64))).toEqual(['arm64']);
    expect(machoArchs(thinMacho(CPU_X86_64))).toEqual(['x86_64']);
  });

  it('reads every slice of a fat header', () => {
    expect(machoArchs(fatMacho(CPU_X86_64, CPU_ARM64))).toEqual(['x86_64', 'arm64']);
  });

  it('is null for non-Mach-O bytes (ELF/PE natives skip the arch check)', () => {
    expect(machoArchs(Buffer.from('\x7fELF plus padding'))).toBeNull();
  });
});

describe('expectedArchForDir', () => {
  it('maps the electron-builder mac output dirs and asserts nothing elsewhere', () => {
    expect(expectedArchForDir('mac/Frink.app/x.node')).toBe('x86_64');
    expect(expectedArchForDir('mac-arm64/Frink.app/x.node')).toBe('arm64');
    expect(expectedArchForDir('win-unpacked/resources/x.node')).toBeNull();
  });
});

describe('assertPackagedAbi', () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const release = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'assert-abi-'));
    for (const [rel, buf] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), buf);
    }
    return dir;
  };
  const sqlite =
    'Frink.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node';

  it('passes a correctly built release and ignores NAPI prebuilds', async () => {
    const d = release({
      [`mac-arm64/${sqlite}`]: Buffer.concat([thinMacho(CPU_ARM64), marker(ELECTRON_ABI)]),
      [`mac/${sqlite}`]: Buffer.concat([thinMacho(CPU_X86_64), marker(ELECTRON_ABI)]),
      // Foreign-arch NAPI prebuild — multi-platform by design, must not trip the arch check.
      'mac/Frink.app/Contents/Resources/app.asar.unpacked/node_modules/bcrypt/prebuilds/darwin-arm64/bcrypt.node':
        thinMacho(CPU_ARM64),
    });
    await expect(assertPackagedAbi(d, { expectedAbi: ELECTRON_ABI })).resolves.toBeUndefined();
  });

  it('refuses a module compiled for system Node (the 0.0.10 boot-crash)', async () => {
    const d = release({
      [`mac-arm64/${sqlite}`]: Buffer.concat([thinMacho(CPU_ARM64), marker(127)]),
    });
    await expect(assertPackagedAbi(d, { expectedAbi: ELECTRON_ABI })).rejects.toThrow(WRONG_ABI);
  });

  it('refuses an arm64 binary inside the x64 app (the 0.0.10 Intel defect)', async () => {
    const d = release({
      [`mac/${sqlite}`]: Buffer.concat([thinMacho(CPU_ARM64), marker(ELECTRON_ABI)]),
    });
    await expect(assertPackagedAbi(d, { expectedAbi: ELECTRON_ABI })).rejects.toThrow(WRONG_ARCH);
  });

  it('passes an all-NAPI release — the expected state since sqlite moved to node:sqlite', async () => {
    const d = release({ [`mac-arm64/${sqlite}`]: Buffer.from('napi only') });
    await expect(assertPackagedAbi(d, { expectedAbi: ELECTRON_ABI })).resolves.toBeUndefined();
  });
});
