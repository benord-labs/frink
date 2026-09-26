import pdfIcon from '@iconify-icons/vscode-icons/file-type-pdf2';
import { FileCode, FileJson, FileText } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { getFileSearchIcon } from './file-icon';

const PdfIcon = iconifyComponent(pdfIcon);

describe('getFileSearchIcon', () => {
  it('returns PdfIcon for .pdf', () => {
    expect(getFileSearchIcon('report.pdf')).toBe(PdfIcon);
  });

  it('returns PdfIcon for .PDF (case-insensitive)', () => {
    expect(getFileSearchIcon('REPORT.PDF')).toBe(PdfIcon);
  });

  it('returns FileCode for .ts', () => {
    expect(getFileSearchIcon('index.ts')).toBe(FileCode);
  });

  it('returns FileCode for .js', () => {
    expect(getFileSearchIcon('script.js')).toBe(FileCode);
  });

  it('returns FileJson for .json', () => {
    expect(getFileSearchIcon('package.json')).toBe(FileJson);
  });

  it('returns FileJson for .yaml', () => {
    expect(getFileSearchIcon('config.yaml')).toBe(FileJson);
  });

  it('returns FileText for an unknown extension', () => {
    expect(getFileSearchIcon('notes.xyz')).toBe(FileText);
  });

  it('returns FileText for a filename with no extension', () => {
    expect(getFileSearchIcon('LICENSE')).toBe(FileText);
  });

  it('returns PdfIcon for a multi-dot filename ending in .pdf', () => {
    expect(getFileSearchIcon('archive.tar.pdf')).toBe(PdfIcon);
  });

  it('returns FileText for a filename that contains "pdf" but is not a .pdf file', () => {
    expect(getFileSearchIcon('report.pdf.bak')).toBe(FileText);
  });

  it('returns FileText for an empty filename', () => {
    expect(getFileSearchIcon('')).toBe(FileText);
  });

  it('returns PdfIcon for a unicode filename ending in .pdf', () => {
    expect(getFileSearchIcon('报告.pdf')).toBe(PdfIcon);
  });
});
