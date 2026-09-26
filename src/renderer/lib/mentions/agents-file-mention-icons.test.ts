import dotenvIcon from '@iconify-icons/vscode-icons/file-type-dotenv';
import jsIcon from '@iconify-icons/vscode-icons/file-type-js';
import markdownIcon from '@iconify-icons/vscode-icons/file-type-markdown';
import typescriptIcon from '@iconify-icons/vscode-icons/file-type-typescript';
import { Files } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { iconifyComponent } from '@/lib/utils/iconify-component';

describe('getFileIconByExtension', () => {
  it('uses dotenv for .env, .env.* basenames and *.env extensions', () => {
    const dotenv = iconifyComponent(dotenvIcon);
    expect(getFileIconByExtension('.env')).toBe(dotenv);
    expect(getFileIconByExtension('path/to/.env')).toBe(dotenv);
    expect(getFileIconByExtension('.env.production')).toBe(dotenv);
    expect(getFileIconByExtension('path/.env.local')).toBe(dotenv);
    expect(getFileIconByExtension('dir/config.env')).toBe(dotenv);
  });

  it('resolves markdown for mixed case, mdx, windows path segments and bare md', () => {
    const markdown = iconifyComponent(markdownIcon);
    expect(getFileIconByExtension('README.MD')).toBe(markdown);
    expect(getFileIconByExtension('docs/readme.mdx')).toBe(markdown);
    expect(getFileIconByExtension('C:\\repo\\docs\\notes.md')).toBe(markdown);
    expect(getFileIconByExtension('md')).toBe(markdown);
  });

  it('uses last path segment for multi-dot names (e.g. .d.ts)', () => {
    expect(getFileIconByExtension('types.d.ts')).toBe(iconifyComponent(typescriptIcon));
  });

  it('ignores dots in parent directories', () => {
    expect(getFileIconByExtension('dir.v2/Makefile', true)).toBeNull();
  });

  it('maps normal and bare .js', () => {
    expect(getFileIconByExtension('file.js')).toBe(iconifyComponent(jsIcon));
    expect(getFileIconByExtension('js')).toBe(iconifyComponent(jsIcon));
  });

  it('returns null for unknown when returnNullForUnknown is true', () => {
    expect(getFileIconByExtension('file.unknownext', true)).toBeNull();
  });

  it('returns the generic Files icon for unknown when returnNullForUnknown is false', () => {
    expect(getFileIconByExtension('file.unknownext', false)).toBe(Files);
  });
});
