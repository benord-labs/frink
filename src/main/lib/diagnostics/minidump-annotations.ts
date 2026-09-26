/**
 * Reads the Crashpad annotation objects (Chromium crash keys such as `page-allocator-mapped-size`
 * or `process_type`) out of a minidump without symbols or an external stackwalker.
 *
 * Struct layouts follow rust-minidump and sentry-electron's minidump parser (both MIT):
 * https://github.com/rust-minidump/rust-minidump · https://github.com/getsentry/sentry-electron
 */

const MINIDUMP_SIGNATURE = 'MDMP';
const HEADER_BYTES = 32;
// Low 16 bits of MINIDUMP_HEADER.version; the high bits carry the writer's implementation stamp.
const MINIDUMP_VERSION = 0xa793;
const CRASHPAD_INFO_STREAM_TYPE = 0x43500001;
const DIRECTORY_ENTRY_BYTES = 12;
const MODULE_LINK_BYTES = 12;
const ANNOTATION_BYTES = 12;
const STRING_ANNOTATION_TYPE = 1;
const MAX_MODULES = 1_000;
const MAX_ANNOTATIONS = 1_000;
const MAX_STRING_BYTES = 100 * 1_024;

type Location = { size: number; rva: number };

/** Crashpad annotation objects by name: Chromium crash keys plus Electron's own `process_type`. */
export type CrashpadAnnotations = Record<string, string>;

function readLocation(buf: Buffer, at: number): Location {
  return { size: buf.readUInt32LE(at), rva: buf.readUInt32LE(at + 4) };
}

function slice(buf: Buffer, location: Location): Buffer {
  if (location.rva + location.size > buf.length) throw new RangeError('location past end');
  return buf.subarray(location.rva, location.rva + location.size);
}

/** Crashpad strings are a u32 byte length followed by UTF-8 bytes. */
function readString(buf: Buffer, rva: number): string {
  const length = buf.readUInt32LE(rva);
  if (length > MAX_STRING_BYTES || rva + 4 + length > buf.length) {
    throw new RangeError('string past end');
  }
  return buf.toString('utf8', rva + 4, rva + 4 + length);
}

// MinidumpModuleCrashpadInfo: version u32, list_annotations, simple_annotations, annotation_objects.
function readAnnotationObjects(buf: Buffer, moduleInfo: Location, into: CrashpadAnnotations): void {
  const info = slice(buf, moduleInfo);
  if (info.length === 0) return;
  const objects = slice(buf, readLocation(info, 20));
  // A module without crash keys links an empty object list; it must not end the walk.
  if (objects.length < 4) return;
  const count = objects.readUInt32LE(0);
  if (count > MAX_ANNOTATIONS) throw new RangeError('annotation count');
  for (let index = 0; index < count; index += 1) {
    // MinidumpAnnotation: name rva u32, type u16, reserved u16, value rva u32.
    const at = 4 + index * ANNOTATION_BYTES;
    if (objects.readUInt16LE(at + 4) !== STRING_ANNOTATION_TYPE) continue;
    into[readString(buf, objects.readUInt32LE(at))] = readString(buf, objects.readUInt32LE(at + 8));
  }
}

// MinidumpCrashpadInfo: version u32, report_id 16 bytes, client_id 16 bytes, simple_annotations,
// module_list (of MinidumpModuleCrashpadInfoLink: module index u32, location).
function readCrashpadInfo(buf: Buffer, stream: Location) {
  const modules = slice(buf, readLocation(slice(buf, stream), 44));
  const count = modules.readUInt32LE(0);
  if (count > MAX_MODULES) throw new RangeError('module count');
  const annotations: CrashpadAnnotations = {};
  for (let index = 0; index < count; index += 1) {
    readAnnotationObjects(
      buf,
      readLocation(modules, 4 + index * MODULE_LINK_BYTES + 4),
      annotations,
    );
  }
  return annotations;
}

/** `{}` for a minidump without Crashpad annotations; `null` for anything truncated or not a minidump. */
export function readCrashpadAnnotations(buf: Buffer): CrashpadAnnotations | null {
  if (buf.length < HEADER_BYTES || buf.toString('latin1', 0, 4) !== MINIDUMP_SIGNATURE) return null;
  if ((buf.readUInt32LE(4) & 0xffff) !== MINIDUMP_VERSION) return null;
  try {
    const streamCount = buf.readUInt32LE(8);
    const directoryRva = buf.readUInt32LE(12);
    if (directoryRva < HEADER_BYTES) return null;
    if (directoryRva + streamCount * DIRECTORY_ENTRY_BYTES > buf.length) return null;
    for (let index = 0; index < streamCount; index += 1) {
      const at = directoryRva + index * DIRECTORY_ENTRY_BYTES;
      if (buf.readUInt32LE(at) !== CRASHPAD_INFO_STREAM_TYPE) continue;
      return readCrashpadInfo(buf, readLocation(buf, at + 4));
    }
    return {};
  } catch {
    // A truncated or malformed dump is no evidence; crash handling must not fail on it.
    return null;
  }
}
