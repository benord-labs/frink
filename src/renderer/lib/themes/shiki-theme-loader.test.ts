import { describe, expect, it } from 'vitest';

import { highlightCode } from './shiki-theme-loader';

/**
 * `highlightCode` is this module's only external export, and its language strings come
 * from markdown fences — often an alias, sometimes a grammar this bundle lacks.
 */
describe('highlightCode', () => {
  it("returns the inner code content rather than shiki's <pre> wrapper", async () => {
    const html = await highlightCode('const x = 1;', 'typescript', 'github-dark');

    expect(html).not.toContain('<pre');
    expect(html).not.toContain('<code');
    expect(html).toContain('const');
  });

  it('resolves short aliases to the same output as the canonical language', async () => {
    const viaAlias = await highlightCode('const x = 1;', 'ts', 'github-dark');
    const viaCanonical = await highlightCode('const x = 1;', 'typescript', 'github-dark');

    expect(viaAlias).toBe(viaCanonical);
  });

  it('falls back to plaintext for a language this bundle has no grammar for', async () => {
    // A fence like ```brainfuck must degrade to unhighlighted text, not throw and
    // take the surrounding message render down with it.
    const html = await highlightCode('some text', 'not-a-real-language', 'github-dark');

    expect(html).toContain('some text');
  });

  it('keys its cache per theme so a theme switch is not served stale output', async () => {
    const code = 'const x = 1;';
    const dark = await highlightCode(code, 'typescript', 'github-dark');
    const light = await highlightCode(code, 'typescript', 'github-light');

    expect(dark).not.toBe(light);
  });

  it('returns a stable result for repeated identical requests', async () => {
    const first = await highlightCode('const y = 2;', 'typescript', 'github-dark');
    const second = await highlightCode('const y = 2;', 'typescript', 'github-dark');

    expect(second).toBe(first);
  });

  it('loads a bundled theme outside the preload list on first use', async () => {
    const html = await highlightCode('const z = 3;', 'typescript', 'dracula');

    expect(html).not.toBe(await highlightCode('const z = 3;', 'typescript', 'github-dark'));
  });

  it('highlights concurrent requests for a theme that is still loading', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c'].map((code) => highlightCode(code, 'typescript', 'nord')),
    );

    expect(results).toHaveLength(3);
    expect(results[0]).not.toBe(await highlightCode('a', 'typescript', 'github-dark'));
  });

  it('handles empty input without throwing', async () => {
    await expect(highlightCode('', 'typescript', 'github-dark')).resolves.toBeTypeOf('string');
  });
});
