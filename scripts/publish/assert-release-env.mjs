#!/usr/bin/env node
/**
 * Release gate: an official build must bake in a usable auto-update feed.
 *
 * The app treats a missing or invalid MAIN_VITE_UPDATE_FEED_URL as "fork build, updater off"
 * (src/main/lib/updates/index.ts). That is right for forks and fatal for an official
 * release: installed users can only move to a build that knows the feed, so a feed-less
 * release strands them for good (sc-3780). Runs before `bun run release` builds anything and
 * before CI's tag builds when R2 publishing is configured.
 *
 * resolveUpdateFeedUrl mirrors the app's resolver; assert-release-env.test.mjs asserts parity.
 */

import { pathToFileURL } from 'node:url';

export function resolveUpdateFeedUrl(raw) {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password) return null;

  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function assertReleaseEnv(env) {
  const raw = env.MAIN_VITE_UPDATE_FEED_URL;
  const feed = resolveUpdateFeedUrl(raw);
  if (feed) return feed;
  throw new Error(
    raw?.trim()
      ? 'MAIN_VITE_UPDATE_FEED_URL is set but unusable: it must be a plain https URL (no quotes, no credentials).'
      : 'MAIN_VITE_UPDATE_FEED_URL is not set. An official release without it ships with auto-update off. See docs/RELEASING.md.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const feed = assertReleaseEnv(process.env);
    console.log(`[assert-release-env] Update feed: ${feed}`);
  } catch (err) {
    console.error(`[assert-release-env] ${err.message}`);
    process.exit(1);
  }
}
