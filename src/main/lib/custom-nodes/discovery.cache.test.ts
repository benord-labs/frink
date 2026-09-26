/**
 * Default-dir discovery TTL cache (CUSTOM_NODES_DIR). FRINK_CUSTOM_NODES_DIR is set to a per-process
 * temp dir before import, so the constant can never resolve the developer's real ~/.frink/nodes.
 */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { NODES_DIR } = vi.hoisted(() => {
  // Avoid imports here: vi.hoisted runs before ESM import bindings initialize.
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  const dir = join(tmpdir(), `frink-nodes-cache-${process.pid}`);
  process.env.FRINK_CUSTOM_NODES_DIR = dir;
  return { NODES_DIR: dir };
});

import {
  CUSTOM_NODES_DIR,
  discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache,
  removeLocalCustomNodeFolder,
} from './discovery';
import { acquireCustomNodeReadLease, beginCustomNodeInstall } from './installation-coordinator';
import { removeTestDir, writeCustomNodeFixture as writeNode } from './test-helpers';

function minimalManifest(name: string) {
  return {
    name,
    displayName: name,
    description: '',
    version: '1.0.0',
    entrypoint: 'run.js',
    timeout: 60,
    inputs: {},
  };
}

afterAll(() => {
  removeTestDir(NODES_DIR);
});

describe('discoverCustomNodes default-dir cache', () => {
  beforeEach(() => {
    expect(CUSTOM_NODES_DIR).toBe(NODES_DIR);
    invalidateCustomNodesDiscoveryCache();
    removeTestDir(CUSTOM_NODES_DIR);
    mkdirSync(CUSTOM_NODES_DIR, { recursive: true });
    writeNode(CUSTOM_NODES_DIR, 'node-a', minimalManifest('node-a'), 'console.log(1)');
  });

  it('serves cached manifests until invalidate after disk changes', () => {
    expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-a']);
    writeNode(CUSTOM_NODES_DIR, 'node-b', minimalManifest('node-b'), 'console.log(1)');
    expect(
      discoverCustomNodes()
        .valid.map((m) => m.name)
        .sort(),
    ).toEqual(['node-a']);
    invalidateCustomNodesDiscoveryCache();
    expect(
      discoverCustomNodes()
        .valid.map((m) => m.name)
        .sort(),
    ).toEqual(['node-a', 'node-b']);
  });

  it('keeps the last complete snapshot visible during an install swap', () => {
    expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-a']);
    const releaseInstall = beginCustomNodeInstall('node-a');
    expect(releaseInstall).not.toBeNull();
    if (!releaseInstall) throw new Error('expected install reservation');

    try {
      removeTestDir(join(CUSTOM_NODES_DIR, 'node-a'));
      writeNode(CUSTOM_NODES_DIR, 'node-b', minimalManifest('node-b'), 'console.log(1)');
      invalidateCustomNodesDiscoveryCache();

      expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-a']);
    } finally {
      releaseInstall();
    }

    invalidateCustomNodesDiscoveryCache();
    expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-b']);
  });

  it('does not delete a node while an unrelated install is in flight', async () => {
    expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-a']);
    const releaseInstall = beginCustomNodeInstall('node-b');
    expect(releaseInstall).not.toBeNull();
    if (!releaseInstall) throw new Error('expected install reservation');

    try {
      await expect(removeLocalCustomNodeFolder('node-a')).resolves.toMatchObject({
        ok: false,
        busy: true,
      });
      expect(existsSync(join(CUSTOM_NODES_DIR, 'node-a'))).toBe(true);
      expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual(['node-a']);
    } finally {
      releaseInstall();
    }

    await expect(removeLocalCustomNodeFolder('node-a')).resolves.toEqual({
      ok: true,
      removed: true,
    });
    expect(discoverCustomNodes().valid.map((m) => m.name)).toEqual([]);
  });

  it('waits for active readers before deleting a node', async () => {
    const releaseReader = await acquireCustomNodeReadLease('node-a');
    expect(releaseReader).not.toBeNull();

    let settled = false;
    const deletion = removeLocalCustomNodeFolder('node-a').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(existsSync(join(CUSTOM_NODES_DIR, 'node-a'))).toBe(true);

    releaseReader?.();
    await expect(deletion).resolves.toEqual({ ok: true, removed: true });
    expect(existsSync(join(CUSTOM_NODES_DIR, 'node-a'))).toBe(false);
  });

  it('preserves the node and releases the writer when active readers miss the deadline', async () => {
    vi.useFakeTimers();
    const releaseReader = await acquireCustomNodeReadLease('node-a');
    expect(releaseReader).not.toBeNull();

    try {
      const deletion = removeLocalCustomNodeFolder('node-a');
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(deletion).resolves.toMatchObject({ ok: false, busy: true });
      expect(existsSync(join(CUSTOM_NODES_DIR, 'node-a'))).toBe(true);

      const releaseNextInstall = beginCustomNodeInstall('node-b');
      expect(releaseNextInstall).not.toBeNull();
      releaseNextInstall?.();
    } finally {
      releaseReader?.();
      vi.useRealTimers();
    }
  });

  it('rescans default dir after cache TTL', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      discoverCustomNodes();
      writeNode(CUSTOM_NODES_DIR, 'node-b', minimalManifest('node-b'), 'console.log(1)');
      vi.advanceTimersByTime(61_000);
      const r = discoverCustomNodes();
      expect(r.valid.map((m) => m.name).sort()).toEqual(['node-a', 'node-b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache non-default nodes directory', () => {
    const alt = join(tmpdir(), `frink-alt-nodes-cache-${process.pid}`);
    removeTestDir(alt);
    mkdirSync(alt, { recursive: true });
    writeNode(alt, 'x-only', minimalManifest('x-only'), 'console.log(1)');
    expect(discoverCustomNodes(alt).valid.map((m) => m.name)).toEqual(['x-only']);
    writeNode(alt, 'y-added', minimalManifest('y-added'), 'console.log(1)');
    expect(
      discoverCustomNodes(alt)
        .valid.map((m) => m.name)
        .sort(),
    ).toEqual(['x-only', 'y-added']);
    removeTestDir(alt);
  });

  it('removeTestDir refuses paths outside its root, including through a symlinked parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'frink-guard-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'frink-guard-outside-'));
    symlinkSync(outside, join(root, 'link'));
    try {
      expect(() => removeTestDir(root, root)).toThrow(/Refusing to delete/);
      expect(() => removeTestDir(join(outside, 'nodes'), root)).toThrow(/Refusing to delete/);
      expect(() => removeTestDir(join(root, 'link', 'nodes'), root)).toThrow(/Refusing to delete/);
      expect(() => removeTestDir(join(root, 'link'), root)).toThrow(/Refusing to delete/);
      expect(existsSync(outside)).toBe(true);
      removeTestDir(join(root, '..dotted'), root);
    } finally {
      removeTestDir(root);
      removeTestDir(outside);
    }
  });
});
