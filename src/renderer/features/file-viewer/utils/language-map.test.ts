import { describe, expect, it } from 'vitest';
import { getFileViewerType, getMonacoLanguage, isDataFile, isImageFile } from './language-map';

describe('language-map', () => {
  describe('getMonacoLanguage', () => {
    it('maps .ts to typescript', () => {
      expect(getMonacoLanguage('src/index.ts')).toBe('typescript');
    });

    it('maps .tsx to typescript', () => {
      expect(getMonacoLanguage('App.tsx')).toBe('typescript');
    });

    it('maps .py to python', () => {
      expect(getMonacoLanguage('script.py')).toBe('python');
    });

    it('maps .rs to rust', () => {
      expect(getMonacoLanguage('main.rs')).toBe('rust');
    });

    it('maps Dockerfile by filename', () => {
      expect(getMonacoLanguage('Dockerfile')).toBe('dockerfile');
    });

    it('maps Makefile by filename', () => {
      expect(getMonacoLanguage('Makefile')).toBe('makefile');
    });

    it('returns plaintext for unknown extension', () => {
      expect(getMonacoLanguage('data.xyz')).toBe('plaintext');
    });

    it('handles full path', () => {
      expect(getMonacoLanguage('/project/src/lib/utils.go')).toBe('go');
    });

    it('maps .json to json', () => {
      expect(getMonacoLanguage('package.json')).toBe('json');
    });

    it('maps .md to markdown', () => {
      expect(getMonacoLanguage('README.md')).toBe('markdown');
    });
  });

  describe('isDataFile', () => {
    it('returns true for .csv', () => {
      expect(isDataFile('data.csv')).toBe(true);
    });

    it('returns true for .parquet', () => {
      expect(isDataFile('output.parquet')).toBe(true);
    });

    it('returns true for .sqlite', () => {
      expect(isDataFile('app.sqlite')).toBe(true);
    });

    it('returns false for .ts', () => {
      expect(isDataFile('index.ts')).toBe(false);
    });

    it('returns false for .json', () => {
      expect(isDataFile('data.json')).toBe(false);
    });
  });

  describe('getFileViewerType', () => {
    it('returns code for .ts', () => {
      expect(getFileViewerType('file.ts')).toBe('code');
    });

    it('returns image for .png', () => {
      expect(getFileViewerType('photo.png')).toBe('image');
    });

    it('returns image for .svg', () => {
      expect(getFileViewerType('icon.svg')).toBe('image');
    });

    it('returns markdown for .md', () => {
      expect(getFileViewerType('README.md')).toBe('markdown');
    });

    it('returns pdf for .pdf', () => {
      expect(getFileViewerType('document.pdf')).toBe('pdf');
    });

    it('returns unsupported for .zip', () => {
      expect(getFileViewerType('archive.zip')).toBe('unsupported');
    });

    it('returns code for unknown extension', () => {
      expect(getFileViewerType('file.xyz')).toBe('code');
    });
  });

  describe('isImageFile', () => {
    it('returns true for .jpg', () => {
      expect(isImageFile('photo.jpg')).toBe(true);
    });

    it('returns true for .webp', () => {
      expect(isImageFile('image.webp')).toBe(true);
    });

    it('returns false for .ts', () => {
      expect(isImageFile('index.ts')).toBe(false);
    });
  });
});
