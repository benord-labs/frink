import { describe, expect, it } from 'vitest';
import { isAllowedShellOpenExternalUrl } from './shell-external-url';

describe('isAllowedShellOpenExternalUrl', () => {
  it('allows http, https, and mailto', () => {
    expect(isAllowedShellOpenExternalUrl('https://example.com/path')).toBe(true);
    expect(isAllowedShellOpenExternalUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedShellOpenExternalUrl('mailto:user@example.com')).toBe(true);
    expect(isAllowedShellOpenExternalUrl('  https://example.com  ')).toBe(true);
  });

  it('allows uppercase scheme URLs from parsers or user input', () => {
    expect(isAllowedShellOpenExternalUrl('HTTP://example.com/')).toBe(true);
    expect(isAllowedShellOpenExternalUrl('HTTPS://example.com/x')).toBe(true);
  });

  it('rejects dangerous or unsupported schemes', () => {
    expect(isAllowedShellOpenExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedShellOpenExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedShellOpenExternalUrl('vscode://file/foo')).toBe(false);
    expect(isAllowedShellOpenExternalUrl('data:text/html,<script>bad</script>')).toBe(false);
    expect(isAllowedShellOpenExternalUrl('')).toBe(false);
    expect(isAllowedShellOpenExternalUrl('   ')).toBe(false);
  });
});
