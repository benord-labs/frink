import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appImageRuntimeProblems,
  assertAppImageRuntime,
  elfLayout,
} from './assert-appimage-runtime.mjs';

const PT_LOAD = 1;
const PT_INTERP = 3;

const DYNAMIC = /dynamically linked/;
const FUSE2 = /references libfuse\.so\.2/;
const NO_PAYLOAD = /no squashfs payload/;
const NOT_ELF = /does not start with a readable ELF runtime/;
const NO_APPIMAGE = /no \.AppImage found/;
const LEGACY_ARM64_ONLY = /Frink-arm64\.AppImage: runtime is dynamically linked/;

/**
 * A minimal little-endian ELF: header, program headers of the given types, `body`, then a
 * two-entry section-header table — so its extent is the buffer's length, as in a real runtime.
 */
const elf = ({ bits = 64, phTypes = [PT_LOAD], body = Buffer.alloc(0) } = {}) => {
  const is64 = bits === 64;
  const ehsize = is64 ? 0x40 : 0x34;
  const phentsize = is64 ? 56 : 32;
  const shentsize = is64 ? 64 : 40;
  const shnum = 2;
  const shoff = ehsize + phTypes.length * phentsize + body.length;
  const b = Buffer.alloc(shoff + shnum * shentsize);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = is64 ? 2 : 1;
  b[5] = 1;
  if (is64) {
    b.writeBigUInt64LE(BigInt(ehsize), 0x20);
    b.writeBigUInt64LE(BigInt(shoff), 0x28);
  } else {
    b.writeUInt32LE(ehsize, 0x1c);
    b.writeUInt32LE(shoff, 0x20);
  }
  const tail = is64 ? 0x36 : 0x2a;
  b.writeUInt16LE(phentsize, tail);
  b.writeUInt16LE(phTypes.length, tail + 2);
  b.writeUInt16LE(shentsize, tail + 4);
  b.writeUInt16LE(shnum, tail + 6);
  phTypes.forEach((type, i) => {
    b.writeUInt32LE(type, ehsize + i * phentsize);
  });
  body.copy(b, ehsize + phTypes.length * phentsize);
  return b;
};

const staticRuntime = (opts) => elf({ body: Buffer.from('fusermount3'), ...opts });
/** The legacy AppImageKit runtime: has an interpreter and dlopens libfuse.so.2. */
const legacyRuntime = () =>
  elf({ phTypes: [PT_LOAD, PT_INTERP], body: Buffer.from('dlopen(): error loading libfuse.so.2') });
const appImage = (runtime, payload = Buffer.from('compressed app')) =>
  Buffer.concat([runtime, Buffer.from('hsqs'), payload]);

describe('elfLayout', () => {
  it('reads the extent and linkage of 64-bit and 32-bit runtimes', () => {
    for (const bits of [64, 32]) {
      const fixed = elf({ bits });
      expect(elfLayout(fixed)).toEqual({ size: fixed.length, hasInterpreter: false });
      const dynamic = elf({ bits, phTypes: [PT_LOAD, PT_INTERP] });
      expect(elfLayout(dynamic)).toEqual({ size: dynamic.length, hasInterpreter: true });
    }
  });

  it('is null for bytes that are not a readable ELF', () => {
    expect(elfLayout(Buffer.alloc(0))).toBeNull();
    expect(elfLayout(Buffer.from('hsqs'.repeat(32)))).toBeNull();
    // Header intact but the program-header table runs past the bytes available.
    expect(elfLayout(elf({ phTypes: [PT_LOAD, PT_LOAD] }).subarray(0, 0x50))).toBeNull();
  });
});

describe('appImageRuntimeProblems', () => {
  it('accepts an AppImage on the static runtime', () => {
    expect(appImageRuntimeProblems(appImage(staticRuntime()))).toEqual([]);
    expect(appImageRuntimeProblems(appImage(staticRuntime({ bits: 32 })))).toEqual([]);
  });

  it('refuses the legacy runtime — the build that cannot start without libfuse2', () => {
    const problems = appImageRuntimeProblems(appImage(legacyRuntime()));
    expect(problems).toEqual([expect.stringMatching(DYNAMIC), expect.stringMatching(FUSE2)]);
  });

  it('refuses a statically linked runtime that still names libfuse.so.2', () => {
    const runtime = staticRuntime({ body: Buffer.from('libfuse.so.2') });
    expect(appImageRuntimeProblems(appImage(runtime))).toEqual([expect.stringMatching(FUSE2)]);
  });

  it('ignores libfuse.so.2 in the app payload — only the runtime prefix is the runtime', () => {
    const payload = Buffer.from('a bundled binary that mentions libfuse.so.2');
    expect(appImageRuntimeProblems(appImage(staticRuntime(), payload))).toEqual([]);
  });

  it('fails closed when no squashfs sits at the ELF extent, instead of checking no bytes', () => {
    // A bare runtime, and one whose payload does not start where the runtime ends.
    expect(appImageRuntimeProblems(staticRuntime())).toEqual([expect.stringMatching(NO_PAYLOAD)]);
    const shifted = Buffer.concat([staticRuntime(), Buffer.from('pad-hsqs')]);
    expect(appImageRuntimeProblems(shifted)).toEqual([expect.stringMatching(NO_PAYLOAD)]);
  });

  it('refuses a file that is not an AppImage at all', () => {
    expect(appImageRuntimeProblems(Buffer.from('hsqs only'))).toEqual([
      expect.stringMatching(NOT_ELF),
    ]);
  });
});

describe('assertAppImageRuntime', () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const release = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'assert-appimage-'));
    for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);
    return dir;
  };

  it('passes a release whose AppImage is on the static runtime, ignoring other artifacts', () => {
    const d = release({
      'Frink-x86_64.AppImage': appImage(staticRuntime()),
      'frink_amd64.deb': Buffer.from('!<arch>'),
      'latest-linux.yml': Buffer.from('version: 1'),
    });
    expect(() => assertAppImageRuntime(d)).not.toThrow();
  });

  it('refuses a release with no AppImage rather than passing vacuously', () => {
    const d = release({ 'frink_amd64.deb': Buffer.from('!<arch>') });
    expect(() => assertAppImageRuntime(d)).toThrow(NO_APPIMAGE);
  });

  it('checks every AppImage, naming the one still on the legacy runtime', () => {
    const d = release({
      'Frink-x86_64.AppImage': appImage(staticRuntime()),
      'Frink-arm64.AppImage': appImage(legacyRuntime()),
    });
    expect(() => assertAppImageRuntime(d)).toThrow(LEGACY_ARM64_ONLY);
  });
});

describe('packaging config', () => {
  it('selects a non-legacy AppImage toolset, so the gate above has something to pass', () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    // Unset or "0.0.0" is electron-builder's legacy (libfuse2) runtime.
    expect(packageJson.build.toolsets?.appimage ?? '0.0.0').not.toBe('0.0.0');
  });
});
