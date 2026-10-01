// bun.lock hygiene (sc-3669). `bun remove` prunes the subtree it drops, but `bun install` on an
// existing lock never prunes, and an entry that still satisfies some package's OPTIONAL peer is
// kept forever (drizzle-orm peers ~20 drivers, so a removed better-sqlite3 stayed locked and
// installed). A fresh resolve would not pick those entries, so a lock carrying them has drifted
// from package.json. The fix is a from-scratch regen: rm bun.lock && env -u GH_PACKAGES_TOKEN bun install.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** bun.lock is JSON with trailing commas. No lock value contains `,}` or `,]` inside a string. */
function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

/** A lock key is a `/`-joined path of package names; a scoped name spans two segments. */
function splitKey(key) {
  const parts = key.split('/');
  const names = [];
  for (let i = 0; i < parts.length; i++) {
    names.push(parts[i].startsWith('@') ? `${parts[i]}/${parts[++i]}` : parts[i]);
  }
  return names;
}

/** Node-style lookup: the nearest nested `scope/name`, walking outwards, then the hoisted root. */
function resolveKey(packages, fromKey, name) {
  const scope = fromKey ? splitKey(fromKey) : [];
  while (scope.length > 0) {
    const key = `${scope.join('/')}/${name}`;
    if (packages[key]) return key;
    scope.pop();
  }
  return packages[name] ? name : null;
}

function entryMeta(entry) {
  return entry.find((v, i) => i > 0 && v && typeof v === 'object' && !Array.isArray(v)) ?? {};
}

/**
 * Walks what a fresh resolve would install: workspace deps, then each entry's dependencies,
 * optionalDependencies and required peers. Optional peers are NOT followed — they are exactly
 * the edges that keep stale entries alive.
 */
function analyzeLock(lock) {
  const packages = lock.packages ?? {};
  const seen = new Set();
  const dangling = [];
  const stack = [];
  const follow = (fromKey, name, from) => {
    const key = resolveKey(packages, fromKey, name);
    if (key) stack.push(key);
    else dangling.push(`${from} -> ${name}`);
  };
  for (const workspace of Object.values(lock.workspaces ?? {})) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(workspace[field] ?? {})) follow('', name, '<workspace>');
    }
  }
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = entryMeta(packages[key]);
    const optionalPeers = new Set(meta.optionalPeers ?? []);
    const names = new Set([
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.optionalDependencies ?? {}),
      ...Object.keys(meta.peerDependencies ?? {}).filter((n) => !optionalPeers.has(n)),
    ]);
    for (const name of names) follow(key, name, key);
  }
  return { unreachable: Object.keys(packages).filter((k) => !seen.has(k)), dangling };
}

function lockOf(packages, rootDeps) {
  return { workspaces: { '': { dependencies: rootDeps } }, packages };
}

describe('bun.lock graph analysis', () => {
  it('parses bun.lock trailing commas', () => {
    expect(parseBunLock('{ "a": [1, 2,], "b": { "c": 1, }, }')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('prefers a nested copy over the hoisted one, walking outwards through scoped names', () => {
    const packages = {
      '@s/a': ['@s/a@1.0.0', '', { dependencies: { b: '^2' } }, 'sha'],
      '@s/a/b': ['b@2.0.0', '', {}, 'sha'],
      b: ['b@1.0.0', '', {}, 'sha'],
    };
    expect(resolveKey(packages, '@s/a', 'b')).toBe('@s/a/b');
    expect(resolveKey(packages, '@s/a/b', 'b')).toBe('@s/a/b');
    expect(resolveKey(packages, 'other', 'b')).toBe('b');
    expect(resolveKey(packages, '', 'missing')).toBeNull();
  });

  it('counts an entry kept alive only by an optional peer as unreachable', () => {
    const lock = lockOf(
      {
        orm: [
          'orm@1.0.0',
          '',
          { peerDependencies: { driver: '*' }, optionalPeers: ['driver'] },
          'sha',
        ],
        driver: ['driver@1.0.0', '', { dependencies: { bindings: '^1' } }, 'sha'],
        bindings: ['bindings@1.0.0', '', {}, 'sha'],
      },
      { orm: '^1' },
    );
    expect(analyzeLock(lock)).toEqual({ unreachable: ['driver', 'bindings'], dangling: [] });
  });

  it('follows an optional peer that is also a regular dependency, and required peers', () => {
    const lock = lockOf(
      {
        orm: [
          'orm@1.0.0',
          '',
          {
            dependencies: { driver: '^1' },
            peerDependencies: { driver: '*', react: '*' },
            optionalPeers: ['driver'],
          },
          'sha',
        ],
        driver: ['driver@1.0.0', '', {}, 'sha'],
        react: ['react@19.0.0', '', {}, 'sha'],
      },
      { orm: '^1' },
    );
    expect(analyzeLock(lock)).toEqual({ unreachable: [], dangling: [] });
  });

  it('reports a dependency edge with no lock entry, including a missing platform binary', () => {
    const lock = lockOf(
      { tool: ['tool@1.0.0', '', { optionalDependencies: { 'tool-win32-x64': '1.0.0' } }, 'sha'] },
      { tool: '^1', gone: '^1' },
    );
    expect(analyzeLock(lock).dangling).toEqual(['<workspace> -> gone', 'tool -> tool-win32-x64']);
  });

  it('treats an empty lock as clean', () => {
    expect(analyzeLock({ workspaces: { '': {} }, packages: {} })).toEqual({
      unreachable: [],
      dangling: [],
    });
  });
});

describe('repository bun.lock', () => {
  const lockText = readFileSync(resolve(ROOT, 'bun.lock'), 'utf8');
  const lock = parseBunLock(lockText);
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

  it('resolves nothing from the private GitHub Packages registry', () => {
    expect(lockText).not.toContain('npm.pkg.github.com');
  });

  it('locks every patched dependency at the exact version its patch targets', () => {
    for (const spec of Object.keys(pkg.patchedDependencies ?? {})) {
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at);
      expect(
        lock.packages[name]?.[0],
        `${spec} is patched but the lock resolves another version`,
      ).toBe(`${name}@${spec.slice(at + 1)}`);
    }
  });

  it('matches the workspace dependency ranges in package.json', () => {
    const workspace = lock.workspaces[''];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      expect(workspace[field] ?? {}, field).toEqual(pkg[field] ?? {});
    }
  });

  // Windows/Linux CI installs this macOS-written lock with --frozen-lockfile, so every
  // platform binary (win32/linux optionalDependencies) must be present, not just darwin's.
  it('resolves every dependency edge, including other platforms’ optional binaries', () => {
    expect(analyzeLock(lock).dangling).toEqual([]);
  });

  it('carries no entry a fresh resolve would drop (regenerate from scratch if this fails)', () => {
    expect(analyzeLock(lock).unreachable).toEqual([]);
  });
});
