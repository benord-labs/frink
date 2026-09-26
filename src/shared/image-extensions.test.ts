import { describe, expect, it } from 'vitest';
import { getImageMimeType, isImagePath } from './image-extensions';

describe('image-extensions', () => {
  describe('isImagePath', () => {
    it('returns true for supported image extensions', () => {
      expect(isImagePath('photo.png')).toBe(true);
      expect(isImagePath('docs/a.jpeg')).toBe(true);
      expect(isImagePath('icon.ico')).toBe(true);
    });

    it('matches case-insensitively', () => {
      expect(isImagePath('Photo.PNG')).toBe(true);
    });

    it('returns false for .svg so it opens as editable code', () => {
      expect(isImagePath('logo.svg')).toBe(false);
    });

    it('returns false for a path with no extension', () => {
      expect(isImagePath('README')).toBe(false);
    });

    it('returns false for a dotfile', () => {
      expect(isImagePath('.gitignore')).toBe(false);
    });

    it('matches on the last extension only', () => {
      expect(isImagePath('archive.tar.gz')).toBe(false);
      expect(isImagePath('sprite.png.bak')).toBe(false);
    });

    it('returns false for extensions that collide with Object prototype members', () => {
      expect(isImagePath('x.constructor')).toBe(false);
      expect(isImagePath('x.toString')).toBe(false);
    });

    it('resolves the extension from the filename, not from a dotted directory', () => {
      expect(isImagePath('docs/v1.2/README')).toBe(false);
      expect(isImagePath('docs/v1.2/diagram.png')).toBe(true);
    });

    it('handles Windows-style separators', () => {
      expect(isImagePath('C:\\Users\\me\\photo.PNG')).toBe(true);
      expect(isImagePath('C:\\my.folder\\README')).toBe(false);
    });

    it('returns false for an empty path or a trailing dot', () => {
      expect(isImagePath('')).toBe(false);
      expect(isImagePath('file.')).toBe(false);
    });
  });

  describe('getImageMimeType', () => {
    it('returns the MIME type for a supported extension', () => {
      expect(getImageMimeType('a.webp')).toBe('image/webp');
      expect(getImageMimeType('a.jpg')).toBe('image/jpeg');
      expect(getImageMimeType('a.jpeg')).toBe('image/jpeg');
    });

    it('returns undefined for unsupported paths', () => {
      expect(getImageMimeType('a.txt')).toBeUndefined();
      expect(getImageMimeType('README')).toBeUndefined();
    });
  });

  // These were independent lookups before, and readImageFile still guards on both in sequence.
  it('never reports a path as an image without also yielding its MIME type', () => {
    const paths = [
      'photo.png',
      'Photo.PNG',
      'docs/a.jpeg',
      'icon.ico',
      'logo.svg',
      'a.txt',
      'README',
      '.gitignore',
      'archive.tar.gz',
      'file.',
      '',
      'x.constructor',
      'C:\\Users\\me\\photo.PNG',
      'docs/v1.2/README',
    ];

    for (const path of paths) {
      expect(isImagePath(path), path).toBe(getImageMimeType(path) !== undefined);
    }
  });
});
