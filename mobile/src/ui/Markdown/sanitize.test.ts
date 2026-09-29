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
    'x !<b></b>[a](https://example.com/track.png)',
    '!<!-- -->[a](https://example.com/track.png)',
    '[x]<i></i>(javascript:alert(1))',
  ])('does not let removed HTML re-form an image or unsafe link: %s', (source) => {
    const result = sanitizeMarkdown(source);
    expect(result).not.toContain('](https://example.com/track.png)');
    expect(result).not.toContain('](javascript:');
    expect(sanitizeMarkdown(result)).toBe(result);
  });
  it('resolves a repeated reference label to its first definition', () => {
    const result = sanitizeMarkdown('[go][d]\n\n[d]: javascript:alert(1)\n[d]: https://ok.example');
    expect(result).not.toContain('[go][d]');
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
