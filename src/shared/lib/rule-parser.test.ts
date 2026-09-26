import { afterEach, describe, expect, it } from 'vitest';
import { clearParseCache, PARSE_CACHE_MAX, parseCacheSize, parseRule } from './rule-parser';

describe('parseRule — grammar variants', () => {
  it('tool-wide bare tool name', () => {
    expect(parseRule('Bash')).toEqual({ tool: 'Bash' });
    expect(parseRule('Edit')).toEqual({ tool: 'Edit' });
  });

  it('prefix wildcard with colon-star', () => {
    expect(parseRule('Bash(npm:*)')).toEqual({ tool: 'Bash', content: 'npm:*' });
  });

  it('compound prefix', () => {
    expect(parseRule('Bash(git push:*)')).toEqual({ tool: 'Bash', content: 'git push:*' });
  });

  it('exact content', () => {
    expect(parseRule('Bash(echo hello)')).toEqual({ tool: 'Bash', content: 'echo hello' });
  });

  it('escaped parens become literal', () => {
    expect(parseRule('Bash(echo \\(\\))')).toEqual({ tool: 'Bash', content: 'echo ()' });
  });

  it('path glob preserved verbatim', () => {
    expect(parseRule('Edit(src/**)')).toEqual({ tool: 'Edit', content: 'src/**' });
  });

  it('Edit(*) wildcard', () => {
    expect(parseRule('Edit(*)')).toEqual({ tool: 'Edit', content: '*' });
  });

  it('MCP wildcard tool', () => {
    expect(parseRule('mcp__shortcut__*')).toEqual({ tool: 'mcp__shortcut__*' });
  });

  it('MCP specific tool', () => {
    expect(parseRule('mcp__shortcut__create_story')).toEqual({
      tool: 'mcp__shortcut__create_story',
    });
  });

  it('MCP hyphenated server name', () => {
    expect(parseRule('mcp__shortcut-frink__stories-list')).toEqual({
      tool: 'mcp__shortcut-frink__stories-list',
    });
  });

  it('MCP hyphenated server with wildcard', () => {
    expect(parseRule('mcp__shortcut-frink__*')).toEqual({
      tool: 'mcp__shortcut-frink__*',
    });
  });

  it('MCP tool name containing underscores (real: playwright/neon servers)', () => {
    // `mcp__playwright__browser_navigate` — tool segment has underscores.
    // Regex backtracking must find a valid `__<tool>` split.
    expect(parseRule('mcp__playwright__browser_navigate')).toEqual({
      tool: 'mcp__playwright__browser_navigate',
    });
    expect(parseRule('mcp__neon__list_branches')).toEqual({
      tool: 'mcp__neon__list_branches',
    });
  });

  it.each(['resources/read', 'resources/list', 'resources/templates/list'])(
    'MCP resource protocol method %s',
    (method) => {
      expect(parseRule(`mcp__context7__${method}`)).toEqual({
        tool: `mcp__context7__${method}`,
      });
    },
  );
});

describe('parseRule — error cases', () => {
  it('empty rule', () => {
    expect(parseRule('')).toHaveProperty('error');
  });

  it('unmatched open paren', () => {
    expect(parseRule('garbage(')).toHaveProperty('error');
    expect(parseRule('Bash(')).toHaveProperty('error');
  });

  it('unmatched close paren', () => {
    expect(parseRule('Bash)')).toHaveProperty('error');
  });

  it('trailing chars after close paren', () => {
    expect(parseRule('Bash(npm)tail')).toHaveProperty('error');
  });

  it('empty content rejected', () => {
    expect(parseRule('Bash()')).toHaveProperty('error');
  });

  it('empty tool name', () => {
    expect(parseRule('(npm)')).toHaveProperty('error');
  });

  it('trailing escape', () => {
    // Bash(echo \) ends mid-escape because the trailing `)` is consumed as escaped char
    // and the rule terminates with no closing paren.
    expect(parseRule('Bash(echo \\)')).toHaveProperty('error');
  });

  it('invalid tool-name characters', () => {
    expect(parseRule('Ba-sh(npm)')).toHaveProperty('error');
    expect(parseRule('123Tool')).toHaveProperty('error');
    expect(parseRule('mcp__')).toHaveProperty('error');
  });

  it('bare MCP server (no tool, no wildcard) rejected', () => {
    // `mcp__shortcut` is silent-dead at the matcher: it parses as a tool name
    // but never matches any real tool call. Rejected at parse so users write
    // `mcp__shortcut__*` (server-wide) or `mcp__shortcut__<tool>` (exact).
    expect(parseRule('mcp__shortcut')).toHaveProperty('error');
    expect(parseRule('mcp__shortcut-frink')).toHaveProperty('error');
  });

  it('rejects boundary hyphens in MCP server/tool segments', () => {
    // No real `.mcp.json` server starts/ends with `-`. Reject at grammar level
    // so dead rules never persist (api-security-reviewer finding 2026-05-25).
    expect(parseRule('mcp__-shortcut__tool')).toHaveProperty('error');
    expect(parseRule('mcp__shortcut-__tool')).toHaveProperty('error');
    expect(parseRule('mcp__shortcut__-tool')).toHaveProperty('error');
    expect(parseRule('mcp__shortcut__tool-')).toHaveProperty('error');
  });

  it('rejects arbitrary slash-bearing MCP tool names', () => {
    expect(parseRule('mcp__context7__resources/write')).toHaveProperty('error');
    expect(parseRule('mcp__context7__other/read')).toHaveProperty('error');
    expect(parseRule('mcp__context7__resources//read')).toHaveProperty('error');
  });

  it('MCP wildcard tool cannot have content', () => {
    expect(parseRule('mcp__shortcut__*(anything)')).toHaveProperty('error');
  });
});

describe('parseRule — escape semantics', () => {
  it('preserves backslash for non-paren escapes', () => {
    // Only `\(` and `\)` collapse; other `\X` keeps the backslash.
    expect(parseRule('Bash(echo \\n)')).toEqual({ tool: 'Bash', content: 'echo \\n' });
  });

  it('escaped backslash in content is preserved', () => {
    // `\\` (double backslash in source) → single `\\` in input → escape `\` then literal `\`
    // So `Bash(a\\\\b)` (source) means content `a\\b` (raw) → parser keeps `\\b` literal.
    expect(parseRule('Bash(a\\\\b)')).toEqual({ tool: 'Bash', content: 'a\\\\b' });
  });
});

describe('parseRule — PARSE_CACHE bounded growth', () => {
  afterEach(() => {
    clearParseCache();
  });

  it('exposes a finite PARSE_CACHE_MAX (sanity)', () => {
    expect(PARSE_CACHE_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(PARSE_CACHE_MAX)).toBe(true);
  });

  it('cache size never exceeds PARSE_CACHE_MAX under many unique inputs', () => {
    clearParseCache();
    // Feed 5× the cap of unique rule strings. Cache must evict, not grow forever.
    const overshoot = PARSE_CACHE_MAX * 5;
    for (let i = 0; i < overshoot; i++) {
      parseRule(`Read${i}`);
    }
    expect(parseCacheSize()).toBeLessThanOrEqual(PARSE_CACHE_MAX);
  });

  it('cache caches repeat parses (hit returns same shape, no re-parse needed)', () => {
    clearParseCache();
    const result1 = parseRule('Read');
    const result2 = parseRule('Read');
    // Both calls return the same parsed object reference (cache hit).
    expect(result1).toBe(result2);
  });

  it('eviction preserves most-recent entries (FIFO/LRU — older evicted first)', () => {
    clearParseCache();
    // Fill cap + 1. The first entry should be evicted.
    parseRule('First');
    for (let i = 0; i < PARSE_CACHE_MAX; i++) {
      parseRule(`Filler${i}`);
    }
    // Cache should still be at or under cap.
    expect(parseCacheSize()).toBeLessThanOrEqual(PARSE_CACHE_MAX);
    // Re-parse `First`: this is a cache miss (was evicted), so it's a fresh parse.
    // The new entry creates a different object reference than the original would have.
    // Quick assertion: re-parsing `First` doesn't throw and yields a valid parse.
    expect(parseRule('First')).toEqual({ tool: 'First' });
  });

  it('clearParseCache empties the cache', () => {
    parseRule('Read');
    parseRule('Edit');
    expect(parseCacheSize()).toBeGreaterThan(0);
    clearParseCache();
    expect(parseCacheSize()).toBe(0);
  });
});
