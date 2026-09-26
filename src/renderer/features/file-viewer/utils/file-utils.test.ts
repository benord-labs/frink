import { describe, expect, it } from 'vitest';
import { formatFileSize, getFileExtension, getFileName } from './file-utils';

describe('file-utils', () => {
  describe('getFileName', () => {
    it('extracts filename from path', () => {
      expect(getFileName('src/components/App.tsx')).toBe('App.tsx');
    });

    it('handles root-level file', () => {
      expect(getFileName('README.md')).toBe('README.md');
    });

    it('handles absolute path', () => {
      expect(getFileName('/home/user/project/index.ts')).toBe('index.ts');
    });

    it('handles trailing slash gracefully', () => {
      expect(getFileName('src/folder/')).toBe('src/folder/');
    });
  });

  describe('formatFileSize', () => {
    it('formats bytes', () => {
      expect(formatFileSize(512)).toBe('512 B');
    });

    it('formats kilobytes', () => {
      expect(formatFileSize(2048)).toBe('2.0 KB');
    });

    it('formats megabytes', () => {
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });

    it('boundary: exactly 1024 bytes', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
    });

    it('boundary: exactly 1 MB', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
    });

    it('handles zero', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });
  });

  describe('getFileExtension', () => {
    it('extracts extension', () => {
      expect(getFileExtension('file.ts')).toBe('.ts');
    });

    it('lowercases extension', () => {
      expect(getFileExtension('Photo.PNG')).toBe('.png');
    });

    it('returns empty for no extension', () => {
      expect(getFileExtension('Makefile')).toBe('');
    });

    it('handles multiple dots', () => {
      expect(getFileExtension('archive.test.ts')).toBe('.ts');
    });
  });
});
