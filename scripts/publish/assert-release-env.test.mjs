import { describe, expect, it } from 'vitest';
import { resolveUpdateFeedUrl as appResolver } from '../../src/main/lib/updates/index.ts';
import { assertReleaseEnv, resolveUpdateFeedUrl } from './assert-release-env.mjs';

// The gate and the app must agree: a value the gate passes but the app rejects ships an
// official build with the updater silently off, stranding every user on that version.
const CASES = [
  undefined,
  '',
  '  \n',
  'http://feed.example/',
  'not a url',
  'https://',
  'file:///tmp/feed/',
  '"https://feed.example/"',
  "'https://feed.example/'",
  'https://user:secret@feed.example/',
  'https://feed.example',
  ' https://feed.example/frink \n',
  'https://feed.example/frink?channel=beta',
  'HTTPS://Feed.Example/',
];

describe('resolveUpdateFeedUrl (release gate copy)', () => {
  it.each(CASES.map((c) => [JSON.stringify(c), c]))(
    'matches the app resolver for %s',
    (_label, raw) => {
      expect(resolveUpdateFeedUrl(raw)).toBe(appResolver(raw));
    },
  );
});

describe('assertReleaseEnv', () => {
  it('throws naming the variable when the feed is unset', () => {
    expect(() => assertReleaseEnv({})).toThrow(/MAIN_VITE_UPDATE_FEED_URL/);
  });

  it('throws when the feed is set but unusable (would ship updater-off)', () => {
    expect(() => assertReleaseEnv({ MAIN_VITE_UPDATE_FEED_URL: 'http://feed.example/' })).toThrow(
      /https/,
    );
  });

  it('returns the normalised feed for a valid value', () => {
    expect(assertReleaseEnv({ MAIN_VITE_UPDATE_FEED_URL: 'https://feed.example' })).toBe(
      'https://feed.example/',
    );
  });
});
