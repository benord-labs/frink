#!/usr/bin/env node
/**
 * Build gate: assert every AppImage under release/ carries the STATIC type2 runtime, not
 * the legacy one that dlopens libfuse.so.2.
 *
 * Why: package.json `build.toolsets.appimage` selects the runtime. Unset (or "0.0.0"),
 * electron-builder embeds the legacy AppImageKit runtime, and stock Ubuntu 22.04+/Fedora —
 * which no longer install libfuse2 — refuse to start the app ("AppImages require FUSE to
 * run"). Nothing else in the build notices: the file is produced, named and sized the same.
 *
 * Detector: an AppImage is `<runtime ELF><squashfs>`. The runtime's length is its own ELF
 * extent (section-header table end — the same sum the runtime uses for --appimage-offset),
 * so the bytes are read straight off disk: no need to execute the artifact, which also
 * keeps this honest for an arch the runner cannot run. Only that prefix is inspected — the
 * squashfs after it is compressed, so scanning the whole file would prove nothing. The
 * static runtime has no PT_INTERP program header; the legacy one is dynamically linked.
 */

import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PT_INTERP = 3;
const SQUASHFS_MAGIC = 'hsqs';
const LEGACY_FUSE_SONAME = 'libfuse.so.2';
// Both runtimes are well under 1 MiB; a prefix this size always holds the whole runtime.
const HEAD_BYTES = 8 * 1024 * 1024;

/**
 * Extent and linkage of the little-endian ELF at the start of buf, or null when buf is not
 * one (or its headers run past the bytes given).
 */
export function elfLayout(buf) {
  if (buf.length < 0x40 || buf.toString('latin1', 0, 4) !== '\x7fELF') return null;
  const is64 = buf[4] === 2;
  if ((!is64 && buf[4] !== 1) || buf[5] !== 1) return null;
  const phoff = is64 ? Number(buf.readBigUInt64LE(0x20)) : buf.readUInt32LE(0x1c);
  const shoff = is64 ? Number(buf.readBigUInt64LE(0x28)) : buf.readUInt32LE(0x20);
  const tail = is64 ? 0x36 : 0x2a; // e_phentsize, e_phnum, e_shentsize, e_shnum — u16 each.
  const phentsize = buf.readUInt16LE(tail);
  const phnum = buf.readUInt16LE(tail + 2);
  const size = shoff + buf.readUInt16LE(tail + 4) * buf.readUInt16LE(tail + 6);
  if (phoff + phnum * phentsize > buf.length) return null;
  let hasInterpreter = false;
  for (let i = 0; i < phnum; i++) {
    if (buf.readUInt32LE(phoff + i * phentsize) === PT_INTERP) hasInterpreter = true;
  }
  return { size, hasInterpreter };
}

/** Why the AppImage whose leading bytes are `head` does not carry the static runtime; empty when it does. */
export function appImageRuntimeProblems(head) {
  const elf = elfLayout(head);
  if (!elf) return ['does not start with a readable ELF runtime'];
  // A wrong extent would make every later check inspect the wrong bytes (or none), so the
  // squashfs superblock must sit exactly where the runtime claims to end.
  if (
    elf.size <= 0 ||
    head.toString('latin1', elf.size, elf.size + SQUASHFS_MAGIC.length) !== SQUASHFS_MAGIC
  ) {
    return [`no squashfs payload at the runtime's ELF extent (${elf.size} bytes)`];
  }
  const problems = [];
  if (elf.hasInterpreter) {
    problems.push('runtime is dynamically linked (legacy runtime), expected the static runtime');
  }
  if (head.subarray(0, elf.size).includes(LEGACY_FUSE_SONAME)) {
    problems.push(`runtime references ${LEGACY_FUSE_SONAME}`);
  }
  return problems;
}

function readHead(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** Throw unless releaseDir holds at least one AppImage and each carries the static runtime. */
export function assertAppImageRuntime(releaseDir) {
  const appImages = readdirSync(releaseDir).filter((name) => name.endsWith('.AppImage'));
  if (appImages.length === 0) {
    throw new Error(`[assert-appimage-runtime] no .AppImage found in ${releaseDir}`);
  }
  const errors = appImages.flatMap((name) =>
    appImageRuntimeProblems(readHead(join(releaseDir, name))).map((p) => `${name}: ${p}`),
  );
  if (errors.length > 0) {
    throw new Error(
      `[assert-appimage-runtime] package.json build.toolsets.appimage must select the static runtime:\n  ${errors.join('\n  ')}`,
    );
  }
  console.log(
    `[assert-appimage-runtime] OK — ${appImages.length} AppImage(s) on the static runtime`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertAppImageRuntime(process.argv[2] ?? 'release');
  } catch (err) {
    console.error(`::error::${err.message.replaceAll('\n', '%0A')}`);
    process.exit(1);
  }
}
