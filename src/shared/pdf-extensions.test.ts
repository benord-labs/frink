import { describe, expect, it } from 'vitest';
import { isPdfPath, MAX_PDF_BYTES } from './pdf-extensions';

describe('pdf-extensions', () => {
  describe('isPdfPath', () => {
    it('returns true for .pdf extension (lowercase)', () => {
      expect(isPdfPath('doc.pdf')).toBe(true);
      expect(isPdfPath('docs/report.pdf')).toBe(true);
    });

    it('returns true for .PDF extension (uppercase)', () => {
      expect(isPdfPath('Report.PDF')).toBe(true);
    });

    it('returns false for non-pdf extensions', () => {
      expect(isPdfPath('file.txt')).toBe(false);
      expect(isPdfPath('image.png')).toBe(false);
    });

    it('returns false for .pdf.bak or similar', () => {
      expect(isPdfPath('doc.pdf.bak')).toBe(false);
    });

    it('returns false for path with no extension', () => {
      expect(isPdfPath('PDF')).toBe(false);
    });
  });

  describe('MAX_PDF_BYTES', () => {
    it('is 20MB', () => {
      expect(MAX_PDF_BYTES).toBe(20 * 1024 * 1024);
    });
  });
});
