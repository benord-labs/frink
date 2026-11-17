import { describe, expect, it } from 'vitest';
import { resolveUpdateFeedUrl } from '.';

describe('resolveUpdateFeedUrl', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['plain http', 'http://feed.example/'],
    ['not a url', 'not a url'],
    ['scheme only', 'https://'],
    ['file scheme', 'file:///tmp/feed/'],
    ['javascript scheme', 'javascript:alert(1)'],
    // A GitHub var or .env value pasted with its quotes kept must disable, not half-parse.
    ['still quoted', '"https://feed.example/"'],
    // Credentials in the feed URL would be baked into every shipped binary.
    ['embedded credentials', 'https://user:secret@feed.example/'],
  ])('returns null for %s', (_label, raw) => {
    expect(resolveUpdateFeedUrl(raw)).toBeNull();
  });

  it('trims surrounding whitespace and trailing newlines from CI vars', () => {
    expect(resolveUpdateFeedUrl('  https://feed.example/ \n')).toBe('https://feed.example/');
  });

  it('adds a trailing slash so electron-updater resolves latest*.yml under the path', () => {
    expect(resolveUpdateFeedUrl('https://feed.example')).toBe('https://feed.example/');
    expect(resolveUpdateFeedUrl('https://feed.example/frink')).toBe('https://feed.example/frink/');
  });

  it('keeps an existing trailing slash (no double slash)', () => {
    expect(resolveUpdateFeedUrl('https://feed.example/frink/')).toBe('https://feed.example/frink/');
  });

  it('adds the slash to the path, not after a query string', () => {
    expect(resolveUpdateFeedUrl('https://feed.example/frink?channel=beta')).toBe(
      'https://feed.example/frink/?channel=beta',
    );
  });

  it('accepts an uppercase scheme', () => {
    expect(resolveUpdateFeedUrl('HTTPS://Feed.Example/')).toBe('https://feed.example/');
  });
});
