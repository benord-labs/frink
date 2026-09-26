import { describe, expect, it } from 'vitest';
import { readCrashpadAnnotations } from './minidump-annotations';

const CRASHPAD_INFO_STREAM_TYPE = 0x43500001;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 12;

type DumpOptions = {
  /** Annotation type written for every object; Crashpad uses 1 for strings. */
  annotationType?: number;
  /** Overrides the annotation object count field, leaving the objects themselves intact. */
  annotationCount?: number;
  /** Links a first module whose annotation-object list is empty, as modules without crash keys are. */
  leadingEmptyModule?: boolean;
};

/** Minimal Crashpad-shaped minidump: header, one directory entry, CrashpadInfo → one module → annotations. */
function buildDump(annotations: Record<string, string>, options: DumpOptions = {}): Buffer {
  const regions: Buffer[] = [];
  let cursor = HEADER_BYTES + DIRECTORY_ENTRY_BYTES;
  const append = (buf: Buffer): number => {
    const rva = cursor;
    regions.push(buf);
    cursor += buf.length;
    return rva;
  };
  const string = (value: string): number => {
    const data = Buffer.from(value, 'utf8');
    const buf = Buffer.alloc(4 + data.length);
    buf.writeUInt32LE(data.length, 0);
    data.copy(buf, 4);
    return append(buf);
  };
  const location = (size: number, rva: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(size, 0);
    buf.writeUInt32LE(rva, 4);
    return buf;
  };
  const u32 = (value: number): Buffer => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    return buf;
  };

  const entries = Object.entries(annotations).map(([name, value]) => ({
    name: string(name),
    value: string(value),
  }));
  const objects = Buffer.alloc(4 + entries.length * 12);
  objects.writeUInt32LE(options.annotationCount ?? entries.length, 0);
  entries.forEach((entry, index) => {
    objects.writeUInt32LE(entry.name, 4 + index * 12);
    objects.writeUInt16LE(options.annotationType ?? 1, 8 + index * 12);
    objects.writeUInt32LE(entry.value, 12 + index * 12);
  });
  const objectsRva = append(objects);
  const moduleInfo = Buffer.concat([
    u32(1),
    location(0, 0),
    location(0, 0),
    location(objects.length, objectsRva),
  ]);
  const moduleInfoRva = append(moduleInfo);
  const emptyModuleInfo = Buffer.concat([u32(1), location(0, 0), location(0, 0), location(0, 0)]);
  const emptyModuleInfoRva = append(emptyModuleInfo);
  const links = options.leadingEmptyModule
    ? Buffer.concat([
        u32(2),
        u32(0),
        location(emptyModuleInfo.length, emptyModuleInfoRva),
        u32(1),
        location(moduleInfo.length, moduleInfoRva),
      ])
    : Buffer.concat([u32(1), u32(0), location(moduleInfo.length, moduleInfoRva)]);
  const linksRva = append(links);
  const info = Buffer.concat([Buffer.alloc(36), location(0, 0), location(links.length, linksRva)]);
  const infoRva = append(info);

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('MDMP', 0, 'latin1');
  header.writeUInt32LE(0xa793, 4);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(HEADER_BYTES, 12);
  const directory = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
  directory.writeUInt32LE(CRASHPAD_INFO_STREAM_TYPE, 0);
  directory.writeUInt32LE(info.length, 4);
  directory.writeUInt32LE(infoRva, 8);
  return Buffer.concat([header, directory, ...regions]);
}

function directoryIntoHeader(): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('MDMP', 0, 'latin1');
  header.writeUInt32LE(0xa793, 4);
  header.writeUInt32LE(1, 8);
  return header;
}

describe('readCrashpadAnnotations', () => {
  const oomAnnotations = {
    'page-allocator-mapped-size': '43487285248',
    'v8-oom-location': 'Heap::AllocateRaw',
    process_type: 'renderer',
  };

  it('reads Chromium crash keys and the Electron process type back out of the module annotations', () => {
    expect(readCrashpadAnnotations(buildDump(oomAnnotations))).toEqual(oomAnnotations);
  });

  it('keeps reading past a module whose annotation-object list is empty', () => {
    expect(
      readCrashpadAnnotations(buildDump(oomAnnotations, { leadingEmptyModule: true })),
    ).toEqual(oomAnnotations);
  });

  it('returns an empty map for a dump with no annotations', () => {
    expect(readCrashpadAnnotations(buildDump({}))).toEqual({});
  });

  it('returns an empty map for a well-formed minidump without a CrashpadInfo stream', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('MDMP', 0, 'latin1');
    header.writeUInt32LE(0xa793, 4);
    header.writeUInt32LE(HEADER_BYTES, 12);
    expect(readCrashpadAnnotations(header)).toEqual({});
  });

  it('ignores annotation objects that are not strings', () => {
    expect(readCrashpadAnnotations(buildDump(oomAnnotations, { annotationType: 2 }))).toEqual({});
  });

  it.each([
    ['not a minidump', Buffer.from('PDF-1.7 not a dump at all, but long enough to read a header')],
    ['a truncated dump', buildDump(oomAnnotations).subarray(0, 60)],
    ['an absurd annotation count', buildDump(oomAnnotations, { annotationCount: 50_000 })],
    ['a count past the object table', buildDump(oomAnnotations, { annotationCount: 4 })],
    ['a truncated header', Buffer.concat([Buffer.from('MDMP'), Buffer.alloc(8)])],
    [
      'a zeroed header with the right signature',
      Buffer.concat([Buffer.from('MDMP'), Buffer.alloc(28)]),
    ],
  ])('returns null instead of throwing for %s', (_label, dump) => {
    expect(readCrashpadAnnotations(dump)).toBeNull();
  });
});
