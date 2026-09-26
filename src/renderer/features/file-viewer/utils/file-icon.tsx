import pdfIcon from '@iconify-icons/vscode-icons/file-type-pdf2';
import { FileCode, FileJson, FileText } from 'lucide-react';
import type { ComponentType } from 'react';
import { iconifyComponent } from '@/lib/utils/iconify-component';

type FileIconComponent = ComponentType<{ className?: string }>;

/**
 * Lightweight icon resolver for quick-open/file-search surfaces.
 * Keeps this path decoupled from heavier mention rendering modules.
 */
export function getFileSearchIcon(filename: string): FileIconComponent {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (
    [
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'php',
      'sh',
      'bash',
    ].includes(ext)
  ) {
    return FileCode;
  }

  if (['json', 'yaml', 'yml', 'xml', 'toml'].includes(ext)) {
    return FileJson;
  }

  if (ext === 'pdf') return iconifyComponent(pdfIcon);

  return FileText;
}
