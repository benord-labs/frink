import { describe, expect, it } from 'vitest';
import { safeWebLink, sanitizeMarkdown } from './sanitize';

describe('mobile transcript Markdown boundary', () => {
  it('preserves formatting and code while removing executable and automatic media content', () => {
    const source =
      '# Plan\n\n**Check** [docs](https://example.com/docs).\n\n![private](https://example.com/track.png)\n\n[run](javascript:alert%281%29)\n\n<img src="https://example.com/track">\n\n```md\n![literal](https://example.com/code.png)\n```';
    const result = sanitizeMarkdown(source);
    expect(result).toContain('**Check** [docs](https://example.com/docs)');
    expect(result).toContain('Image: private');
    expect(result).not.toContain('track.png');
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('<img');
    expect(result).toContain('```md\n![literal](https://example.com/code.png)\n```');
  });
  it('blocks nested and reference images and unsafe reference links without destroying safe links', () => {
    const result = sanitizeMarkdown(
      '[![alt][photo]](https://example.com)\n\n[open][local]\n\n[safe][docs]\n\n[photo]: https://example.com/image.png\n[local]: file:///private/file.txt\n[docs]: https://example.com/docs',
    );
    expect(result).toContain('[Image: alt');
    expect(result).not.toContain('![alt]');
    expect(result).not.toContain('[open][local]');
    expect(result).toContain('[safe][docs]');
  });
  it.each([
    'javascript:alert(1)',
    'file:///private/a',
    'frink://execute',
    'data:text/html,hi',
    '//example.com',
    '/relative',
    'https://user:password@example.com',
  ])('rejects unsafe or implicit link %s', (url) => {
    expect(safeWebLink(url)).toBe(false);
  });
  it.each(['https://example.com/path', 'http://localhost:3000/'])(
    'allows explicit web link %s',
    (url) => {
      expect(safeWebLink(url)).toBe(true);
    },
  );
});
