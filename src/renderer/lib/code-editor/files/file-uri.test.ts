import { describe, expect, it } from 'vitest';
import { encodeFileUri } from './file-uri';

describe('encodeFileUri', () => {
  it('encodes URI-significant characters per path segment', () => {
    expect(encodeFileUri('/path/to/file#1?.ts')).toBe('file:///path/to/file%231%3F.ts');
  });

  it('encodes spaces and percent signs without encoding separators', () => {
    expect(encodeFileUri('/path/with space/100% done.ts')).toBe(
      'file:///path/with%20space/100%25%20done.ts',
    );
  });

  it('preserves empty segments as consecutive slashes (split on / only)', () => {
    expect(encodeFileUri('/path//file.ts')).toBe('file:///path//file.ts');
    expect(encodeFileUri('/a///b')).toBe('file:///a///b');
  });

  it('keeps leading and trailing slashes from segment boundaries', () => {
    expect(encodeFileUri('/foo')).toBe('file:///foo');
    expect(encodeFileUri('/foo/')).toBe('file:///foo/');
  });

  it('rejects relative paths so file URIs are not parsed with a bogus authority', () => {
    expect(() => encodeFileUri('foo/bar')).toThrow(/absolute path/);
  });

  it('encodes non-ASCII per segment (Unicode NFC in path)', () => {
    expect(encodeFileUri('/tmp/café/münchen.ts')).toBe('file:///tmp/caf%C3%A9/m%C3%BCnchen.ts');
    expect(encodeFileUri('/中文/文件.ts')).toBe('file:///%E4%B8%AD%E6%96%87/%E6%96%87%E4%BB%B6.ts');
  });

  it('re-encodes percent sequences inside a segment (literal % becomes %25)', () => {
    expect(encodeFileUri('/x/hello%20world/y')).toBe('file:///x/hello%2520world/y');
  });

  it('does not treat dot segments specially; they encode like any segment name', () => {
    expect(encodeFileUri('/foo/./bar')).toBe('file:///foo/./bar');
    expect(encodeFileUri('/foo/../bar')).toBe('file:///foo/../bar');
  });
});
