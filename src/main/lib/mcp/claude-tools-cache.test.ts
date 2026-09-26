import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../claude-config';
import {
  _resetClaudeToolsCacheForTests,
  CLAUDE_TOOLS_CACHE_TTL_MS,
  CLAUDE_TOOLS_NEGATIVE_TTL_MS,
  claudeConfigFingerprint,
  claudeMcpCacheKey,
  invalidateClaudeMcpToolsCache,
  readClaudeToolsCache,
  readClaudeToolsCacheEntry,
  refreshClaudeToolsCache,
  writeClaudeToolsCache,
} from './claude-tools-cache';

// Stable starting timestamp — fake timers use this so TTL math is predictable.
const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  _resetClaudeToolsCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

const cfg = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: 'node',
  args: ['server.js'],
  ...overrides,
});

describe('claudeMcpCacheKey', () => {
  it('uses the GLOBAL_MCP_PATH constant for null projectPath', () => {
    expect(claudeMcpCacheKey(null, 'gh')).toBe('__global__:gh');
  });

  it('isolates entries by project path', () => {
    expect(claudeMcpCacheKey('/p1', 'gh')).toBe('/p1:gh');
    expect(claudeMcpCacheKey('/p2', 'gh')).toBe('/p2:gh');
    expect(claudeMcpCacheKey('/p1', 'gh')).not.toBe(claudeMcpCacheKey('/p2', 'gh'));
  });
});

describe('claudeConfigFingerprint', () => {
  it('returns the same fingerprint for two configs with the same shape', () => {
    expect(claudeConfigFingerprint(cfg())).toBe(claudeConfigFingerprint(cfg()));
  });

  it('changes when env keys change (added/removed)', () => {
    const a = claudeConfigFingerprint(cfg({ env: { TOKEN: 'x' } as Record<string, string> }));
    const b = claudeConfigFingerprint(cfg());
    expect(a).not.toBe(b);
  });

  it('changes when an env VALUE changes under the same key name', () => {
    const a = claudeConfigFingerprint(cfg({ env: { TOKEN: 'x' } as Record<string, string> }));
    const b = claudeConfigFingerprint(cfg({ env: { TOKEN: 'y' } as Record<string, string> }));
    expect(a).not.toBe(b);
  });

  it('changes when args change', () => {
    expect(claudeConfigFingerprint(cfg({ args: ['a'] }))).not.toBe(
      claudeConfigFingerprint(cfg({ args: ['a', 'b'] })),
    );
  });

  it('changes when OAuth presence flips AND when the token value rotates', () => {
    const noOauth = claudeConfigFingerprint(cfg());
    const withOauth = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-1' } }));
    const rotatedOauth = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-2' } }));

    expect(withOauth).not.toBe(noOauth);
    // Value-sensitive: a rotation changes the fingerprint, so a stale write from a
    // probe holding the old token self-invalidates on the next read (no masking).
    expect(withOauth).not.toBe(rotatedOauth);
  });

  it('never stores the raw secret — the fingerprint is a hash', () => {
    const fp = claudeConfigFingerprint(
      cfg({ _oauth: { accessToken: 'super-secret-token' }, env: { KEY: 'raw-value' } }),
    );
    expect(fp).not.toContain('super-secret-token');
    expect(fp).not.toContain('raw-value');
  });
});

describe('readClaudeToolsCache / writeClaudeToolsCache', () => {
  it('returns the cached tools on a hit within TTL with matching fingerprint', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    writeClaudeToolsCache(key, ['list_repos', 'create_issue'], fp);

    expect(readClaudeToolsCache(key, fp)).toEqual(['list_repos', 'create_issue']);
  });

  it('returns null when the fingerprint does not match', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    writeClaudeToolsCache(key, ['list_repos'], 'fp-1');
    expect(readClaudeToolsCache(key, 'fp-2')).toBeNull();
  });

  it('returns null after TTL has elapsed', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    writeClaudeToolsCache(key, ['list_repos'], fp);
    expect(readClaudeToolsCache(key, fp)).toEqual(['list_repos']);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);

    expect(readClaudeToolsCache(key, fp)).toBeNull();
  });

  it('negative-caches an empty probe within the short TTL, then self-heals', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    writeClaudeToolsCache(key, [], fp);

    // Within the negative window: the empty is served (no re-probe every load).
    expect(readClaudeToolsCache(key, fp)).toEqual([]);

    // Past the negative window but before the success TTL: entry expires → re-probe.
    vi.advanceTimersByTime(CLAUDE_TOOLS_NEGATIVE_TTL_MS);
    expect(readClaudeToolsCache(key, fp)).toBeNull();
  });

  it('expires an empty entry far sooner than a populated one (negative < success TTL)', () => {
    const fp = claudeConfigFingerprint(cfg());
    const emptyKey = claudeMcpCacheKey(null, 'down');
    const fullKey = claudeMcpCacheKey(null, 'up');

    writeClaudeToolsCache(emptyKey, [], fp);
    writeClaudeToolsCache(fullKey, ['tool_a'], fp);

    vi.advanceTimersByTime(CLAUDE_TOOLS_NEGATIVE_TTL_MS);

    expect(readClaudeToolsCache(emptyKey, fp)).toBeNull(); // negative TTL elapsed
    expect(readClaudeToolsCache(fullKey, fp)).toEqual(['tool_a']); // success TTL still valid
  });

  it('self-invalidates a stale write from a probe that raced a token rotation (no masked re-auth)', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const oldFp = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-1' } }));
    const newFp = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-2' } }));

    // A slow probe holding the pre-rotation token writes back an empty (auth failed)
    // AFTER the token rotated. It carries the OLD fingerprint.
    writeClaudeToolsCache(key, [], oldFp);

    // The next load computes the NEW (post-rotation) fingerprint → the stale empty
    // is a miss, not a served negative → the server re-probes with the fresh token.
    expect(readClaudeToolsCache(key, newFp)).toBeNull();
  });

  it('does not let a transient empty write clobber a still-fresh success (concurrent same-key probes)', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    // Faster probe returns tools; slower same-key probe then returns empty.
    writeClaudeToolsCache(key, ['list_repos'], fp);
    writeClaudeToolsCache(key, [], fp);

    expect(readClaudeToolsCache(key, fp)).toEqual(['list_repos']);
  });

  it('still negative-caches an empty when there is no fresh success to protect', () => {
    const key = claudeMcpCacheKey(null, 'down');
    const fp = claudeConfigFingerprint(cfg());

    writeClaudeToolsCache(key, [], fp); // no prior entry → cached (negative)
    expect(readClaudeToolsCache(key, fp)).toEqual([]);

    // A later success is authoritative and replaces the negative entry.
    writeClaudeToolsCache(key, ['tool_a'], fp);
    expect(readClaudeToolsCache(key, fp)).toEqual(['tool_a']);
  });

  it('lets an empty overwrite a stale (expired) success rather than serving it forever', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    writeClaudeToolsCache(key, ['list_repos'], fp);
    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS); // success TTL elapsed
    writeClaudeToolsCache(key, [], fp); // existing is stale → empty wins (negative-cached)

    expect(readClaudeToolsCache(key, fp)).toEqual([]);
  });

  it('keeps disjoint key namespaces isolated (agg: vs project/global)', () => {
    // The mcp router writes under `agg:<name>` with its own fingerprint; a
    // matching claude-side key must never cross-serve.
    writeClaudeToolsCache('agg:gh', ['agg_tool'], 'agg-fp');
    writeClaudeToolsCache(claudeMcpCacheKey(null, 'gh'), ['claude_tool'], 'claude-fp');

    expect(readClaudeToolsCache('agg:gh', 'agg-fp')).toEqual(['agg_tool']);
    expect(readClaudeToolsCache(claudeMcpCacheKey(null, 'gh'), 'claude-fp')).toEqual([
      'claude_tool',
    ]);
    // A namespace read with the wrong fingerprint misses (no cross-serve).
    expect(readClaudeToolsCache('agg:gh', 'claude-fp')).toBeNull();
  });

  it('isolates entries by full cache key (per-project)', () => {
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(claudeMcpCacheKey('/p1', 'gh'), ['p1_tool'], fp);
    writeClaudeToolsCache(claudeMcpCacheKey('/p2', 'gh'), ['p2_tool'], fp);

    expect(readClaudeToolsCache(claudeMcpCacheKey('/p1', 'gh'), fp)).toEqual(['p1_tool']);
    expect(readClaudeToolsCache(claudeMcpCacheKey('/p2', 'gh'), fp)).toEqual(['p2_tool']);
  });
});

describe('readClaudeToolsCacheEntry (stale-while-revalidate reader)', () => {
  it('returns a fresh entry tagged stale:false within TTL', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(key, ['list_repos'], fp);

    expect(readClaudeToolsCacheEntry(key, fp)).toMatchObject({
      tools: ['list_repos'],
      stale: false,
    });
  });

  it('returns the entry tagged stale:true past the success TTL (still fingerprint-matched)', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(key, ['list_repos'], fp);

    vi.advanceTimersByTime(CLAUDE_TOOLS_CACHE_TTL_MS);

    // The fresh-only reader misses, but SWR gets the stale tools to serve instantly.
    expect(readClaudeToolsCache(key, fp)).toBeNull();
    expect(readClaudeToolsCacheEntry(key, fp)).toMatchObject({
      tools: ['list_repos'],
      stale: true,
    });
  });

  it('is a hard miss (null) when the fingerprint does not match — never serve another config', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    writeClaudeToolsCache(key, ['list_repos'], 'fp-1');
    expect(readClaudeToolsCacheEntry(key, 'fp-2')).toBeNull();
  });

  it('returns null when the entry is absent', () => {
    expect(readClaudeToolsCacheEntry(claudeMcpCacheKey(null, 'never'), 'fp')).toBeNull();
  });

  it('tags a stale empty (negative) entry stale:true with an empty tools array', () => {
    const key = claudeMcpCacheKey(null, 'down');
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(key, [], fp);

    vi.advanceTimersByTime(CLAUDE_TOOLS_NEGATIVE_TTL_MS);

    expect(readClaudeToolsCacheEntry(key, fp)).toMatchObject({ tools: [], stale: true });
  });
});

describe('refreshClaudeToolsCache (fingerprint + revision guarded background write)', () => {
  /** The (fingerprint, revision) pair a revalidation would capture when it launches. */
  const launchToken = (key: string, fp: string): number => {
    const entry = readClaudeToolsCacheEntry(key, fp);
    if (!entry) throw new Error('expected an entry to refresh');
    return entry.revision;
  };

  it('refreshes an entry that is still the one the revalidation was launched for', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(key, ['old'], fp);
    const revision = launchToken(key, fp);

    refreshClaudeToolsCache(key, ['new'], fp, revision);

    expect(readClaudeToolsCache(key, fp)).toEqual(['new']);
  });

  it('does NOT clobber a newer-fingerprint entry (a late revalidation lost the race)', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fpA = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-1' } }));
    const fpB = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-2' } }));

    writeClaudeToolsCache(key, ['a_tool'], fpA);
    const revisionA = launchToken(key, fpA);
    // Config rotates to B before the fp-A revalidation returns.
    writeClaudeToolsCache(key, ['b_tool'], fpB);
    refreshClaudeToolsCache(key, ['a_stale'], fpA, revisionA);

    expect(readClaudeToolsCache(key, fpB)).toEqual(['b_tool']); // fp-B entry survives
    expect(readClaudeToolsCacheEntry(key, fpA)).toBeNull(); // fp-A was never restored
  });

  it('does NOT clobber a newer entry that cycled back to the original fingerprint (A → B → A)', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fpA = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-1' } }));
    const fpB = claudeConfigFingerprint(cfg({ _oauth: { accessToken: 'tok-2' } }));

    // A revalidation launches against this fp-A entry...
    writeClaudeToolsCache(key, ['a_old'], fpA);
    const revisionA = launchToken(key, fpA);

    // ...then the config rotates to B and back to A, re-probed fresh each time.
    writeClaudeToolsCache(key, ['b_tool'], fpB);
    writeClaudeToolsCache(key, ['a_new'], fpA);

    // The late refresh matches on fingerprint but NOT on revision — it must be dropped,
    // otherwise it would overwrite the fresh fp-A entry with obsolete tools.
    refreshClaudeToolsCache(key, ['a_old'], fpA, revisionA);

    expect(readClaudeToolsCache(key, fpA)).toEqual(['a_new']);
  });

  it('does not resurrect an invalidated (absent) entry', () => {
    const key = claudeMcpCacheKey(null, 'gh');
    const fp = claudeConfigFingerprint(cfg());

    refreshClaudeToolsCache(key, ['tool'], fp, 1); // nothing to refresh

    expect(readClaudeToolsCache(key, fp)).toBeNull();
  });
});

describe('invalidateClaudeMcpToolsCache', () => {
  it('removes only the specified key when called with an argument', () => {
    const fp = claudeConfigFingerprint(cfg());
    const k1 = claudeMcpCacheKey(null, 'gh');
    const k2 = claudeMcpCacheKey(null, 'slack');

    writeClaudeToolsCache(k1, ['gh_tool'], fp);
    writeClaudeToolsCache(k2, ['slack_tool'], fp);

    invalidateClaudeMcpToolsCache(k1);

    expect(readClaudeToolsCache(k1, fp)).toBeNull();
    expect(readClaudeToolsCache(k2, fp)).toEqual(['slack_tool']);
  });

  it('clears every entry when called with no argument', () => {
    const fp = claudeConfigFingerprint(cfg());
    writeClaudeToolsCache(claudeMcpCacheKey(null, 'gh'), ['x'], fp);
    writeClaudeToolsCache(claudeMcpCacheKey('/p', 'gh'), ['y'], fp);

    invalidateClaudeMcpToolsCache();

    expect(readClaudeToolsCache(claudeMcpCacheKey(null, 'gh'), fp)).toBeNull();
    expect(readClaudeToolsCache(claudeMcpCacheKey('/p', 'gh'), fp)).toBeNull();
  });
});
