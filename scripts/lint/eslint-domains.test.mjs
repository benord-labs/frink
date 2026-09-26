// Guards the domain registry itself — the one structure config agents are
// tempted to pollute (appending a grab-bag domain is the cheapest escape from
// the folder-only lib/ walls). Deliberately light: names must be kebab, unique,
// and not junk-drawers; no ordering or naming-style opinions beyond that.
import { describe, expect, it } from 'vitest';
import { MAIN_LIB_DOMAINS, MAIN_ROOT_FOLDERS, RENDERER_LIB_DOMAINS } from '../../eslint/domains.mjs';

const KEBAB = /^[a-z][a-z0-9-]*$/;
// Names that defeat the registry's purpose: a domain must be the concern it
// owns, never a pile for "everything else".
const JUNK = new Set([
  'misc',
  'miscellaneous',
  'helpers',
  'helper',
  'common',
  'general',
  'shared',
  'stuff',
  'other',
  'temp',
  'tmp',
  'util',
  'utilities',
]);

describe.each([
  ['RENDERER_LIB_DOMAINS', RENDERER_LIB_DOMAINS],
  ['MAIN_LIB_DOMAINS', MAIN_LIB_DOMAINS],
  ['MAIN_ROOT_FOLDERS', MAIN_ROOT_FOLDERS],
])('%s', (_name, list) => {
  it('is non-empty, kebab-case, and free of duplicates', () => {
    expect(list.length).toBeGreaterThan(0);
    for (const d of list) expect(d).toMatch(KEBAB);
    expect(new Set(list).size).toBe(list.length);
  });

  it('contains no junk-drawer names (a domain owns ONE concern)', () => {
    for (const d of list) expect(JUNK.has(d), `"${d}" is a junk-drawer name`).toBe(false);
  });
});

// 'utils' is grandfathered in RENDERER_LIB_DOMAINS as the ONE renderer utils
// home (docs/developer-docs/directory-structure.md §3) — assert no second utils home appears.
// (Exact names only: 'test-utils' on main is a real concern, not a junk pile.)
it('keeps exactly one utils home (renderer/lib/utils)', () => {
  expect(RENDERER_LIB_DOMAINS).toContain('utils');
  expect(MAIN_LIB_DOMAINS).not.toContain('utils');
});
