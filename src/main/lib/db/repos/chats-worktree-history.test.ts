/**
 * Pure history helpers for the per-chat worktree-history feature. Defensive parser must
 * tolerate malformed/legacy JSON because the column lives alongside data written by older
 * builds (NULL or hand-edited rows).
 */

import { describe, expect, it } from 'vitest';
import {
  appendWorktreeHistory,
  lookupWorktreeHistoryEntry,
  parseWorktreeHistory,
  pruneWorktreeHistoryEntry,
} from './chats';

describe('parseWorktreeHistory', () => {
  it('returns {} for null/undefined/empty input', () => {
    expect(parseWorktreeHistory(null)).toEqual({});
    expect(parseWorktreeHistory(undefined)).toEqual({});
    expect(parseWorktreeHistory('')).toEqual({});
  });

  it('parses a valid JSON object of string→string', () => {
    expect(parseWorktreeHistory('{"p1":"/a","p2":"/b"}')).toEqual({ p1: '/a', p2: '/b' });
  });

  it('drops entries with non-string values', () => {
    expect(parseWorktreeHistory('{"p1":"/a","p2":123,"p3":null}')).toEqual({ p1: '/a' });
  });

  it('returns {} on malformed JSON', () => {
    expect(parseWorktreeHistory('{not json')).toEqual({});
  });

  it('returns {} when JSON parses to a non-object (array, string, number, null)', () => {
    expect(parseWorktreeHistory('[]')).toEqual({});
    expect(parseWorktreeHistory('"str"')).toEqual({});
    expect(parseWorktreeHistory('42')).toEqual({});
    expect(parseWorktreeHistory('null')).toEqual({});
  });
});

describe('appendWorktreeHistory', () => {
  it('adds a new entry', () => {
    expect(appendWorktreeHistory({}, 'p1', '/a')).toEqual({ p1: '/a' });
  });

  it('overwrites an existing entry (latest visit wins)', () => {
    expect(appendWorktreeHistory({ p1: '/old' }, 'p1', '/new')).toEqual({ p1: '/new' });
  });

  it('no-ops when projectId or worktreePath is null/empty', () => {
    const h = { p1: '/a' };
    expect(appendWorktreeHistory(h, null, '/x')).toBe(h);
    expect(appendWorktreeHistory(h, 'p2', null)).toBe(h);
    expect(appendWorktreeHistory(h, '', '/x')).toBe(h);
  });

  it('returns a new object (does not mutate input)', () => {
    const h = { p1: '/a' };
    const out = appendWorktreeHistory(h, 'p2', '/b');
    expect(out).not.toBe(h);
    expect(h).toEqual({ p1: '/a' });
  });

  it('preserves insertion order when overwriting an existing key (origin invariant)', () => {
    // `frink_navigation_context` derives `origin` as `history[0]` — the FIRST projectId in
    // insertion order, i.e. the project the chat left first. If overwriting an existing key
    // moved it to the end (e.g. with a different spread strategy), `origin` would silently
    // shift each time the chat revisits its starting project. Lock this invariant.
    let h = appendWorktreeHistory({}, 'p1', '/wt/first');
    h = appendWorktreeHistory(h, 'p2', '/wt/second');
    h = appendWorktreeHistory(h, 'p3', '/wt/third');
    expect(Object.keys(h)).toEqual(['p1', 'p2', 'p3']);

    // Round-trip back to p1: overwrite must NOT reposition p1.
    const overwritten = appendWorktreeHistory(h, 'p1', '/wt/first-revisit');
    expect(Object.keys(overwritten)).toEqual(['p1', 'p2', 'p3']);
    expect(overwritten.p1).toBe('/wt/first-revisit');
  });
});

describe('lookupWorktreeHistoryEntry', () => {
  it('returns the stored path', () => {
    expect(lookupWorktreeHistoryEntry({ p1: '/a' }, 'p1')).toBe('/a');
  });

  it('returns null on miss', () => {
    expect(lookupWorktreeHistoryEntry({ p1: '/a' }, 'p2')).toBeNull();
  });

  it('returns null when projectId is null', () => {
    expect(lookupWorktreeHistoryEntry({ p1: '/a' }, null)).toBeNull();
  });
});

describe('pruneWorktreeHistoryEntry', () => {
  it('removes the entry and returns a new object', () => {
    const h = { p1: '/a', p2: '/b' };
    const out = pruneWorktreeHistoryEntry(h, 'p1');
    expect(out).toEqual({ p2: '/b' });
    expect(out).not.toBe(h);
    expect(h).toEqual({ p1: '/a', p2: '/b' });
  });

  it('returns the same reference when the entry is absent (no-op)', () => {
    const h = { p1: '/a' };
    expect(pruneWorktreeHistoryEntry(h, 'p2')).toBe(h);
  });
});
