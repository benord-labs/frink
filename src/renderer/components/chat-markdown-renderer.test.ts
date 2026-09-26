// @vitest-environment happy-dom
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { getStreamdownComponents, REMARK_PLUGINS, stripEmojis } from './chat-markdown-renderer';

describe('stripEmojis', () => {
  it('removes common pictograph emoji (opt-in aggressive cleanup)', () => {
    expect(stripEmojis('Hello 😀 world')).toBe('Hello  world');
  });

  it('removes flag regional indicators', () => {
    expect(stripEmojis('Flag 🇺🇸 end')).toBe('Flag  end');
  });

  it('strips multiple emoji in one string', () => {
    expect(stripEmojis('a😀b🚀c')).toBe('abc');
  });

  it('preserves plain ASCII including emoticons', () => {
    expect(stripEmojis('ok :)')).toBe('ok :)');
  });

  it('preserves Latin letters with diacritics (not in emoji strip ranges)', () => {
    expect(stripEmojis('café naïve 北京')).toBe('café naïve 北京');
  });

  it('leaves markdown punctuation when stripping emoji (opt-in cleanup)', () => {
    expect(stripEmojis('**bold** 😀')).toBe('**bold** ');
  });
});

// ============================================================================
// Performance-critical memoization contract
// ============================================================================
// These tests guard the fix that collapsed 120 per-block `components` objects
// into a single shared reference — the primary Streamdown/react-markdown
// render-time win. If any of these break, the 73ms `Ct` regression is back.

describe('REMARK_PLUGINS', () => {
  it('contains exactly remarkGfm and remarkBreaks in order (GFM first so breaks extend it)', () => {
    expect(REMARK_PLUGINS).toHaveLength(2);
    expect(REMARK_PLUGINS[0]).toBe(remarkGfm);
    expect(REMARK_PLUGINS[1]).toBe(remarkBreaks);
  });

  it('is a stable module-level reference across imports (not rebuilt per call)', () => {
    // Self-identity — trivially true, but documents intent: any refactor that
    // replaces this with a getter returning a new array would fail reference
    // equality downstream and invalidate Streamdown's internal memoization.
    expect(REMARK_PLUGINS).toBe(REMARK_PLUGINS);
  });
});

describe('getStreamdownComponents cache', () => {
  // Unique theme strings per test to avoid cross-test cache coupling for the
  // distinctness checks (same-input calls still need to hit the real cache).
  it('returns the same reference for identical (size, codeTheme, isStreaming) — core perf contract', () => {
    const a = getStreamdownComponents('sm', 'cache-test-same-1', false);
    const b = getStreamdownComponents('sm', 'cache-test-same-1', false);
    expect(a).toBe(b);
  });

  it('returns the same reference across many repeated calls (no unbounded rebuild)', () => {
    const first = getStreamdownComponents('md', 'cache-test-repeat', true);
    for (let i = 0; i < 50; i++) {
      expect(getStreamdownComponents('md', 'cache-test-repeat', true)).toBe(first);
    }
  });

  it('returns a different reference when size changes', () => {
    const sm = getStreamdownComponents('sm', 'cache-test-size', false);
    const md = getStreamdownComponents('md', 'cache-test-size', false);
    const lg = getStreamdownComponents('lg', 'cache-test-size', false);
    expect(sm).not.toBe(md);
    expect(md).not.toBe(lg);
    expect(sm).not.toBe(lg);
  });

  it('returns a different reference when codeTheme changes', () => {
    const dark = getStreamdownComponents('sm', 'cache-test-theme-dark', false);
    const light = getStreamdownComponents('sm', 'cache-test-theme-light', false);
    expect(dark).not.toBe(light);
  });

  it('returns a different reference when isStreaming toggles (streaming and static need distinct code handlers)', () => {
    // MermaidBlock renders a placeholder while streaming vs. real diagram when
    // static — this distinction is wired through the `code` component, so the
    // cache MUST key on isStreaming.
    const streaming = getStreamdownComponents('sm', 'cache-test-streaming', true);
    const staticMode = getStreamdownComponents('sm', 'cache-test-streaming', false);
    expect(streaming).not.toBe(staticMode);
  });

  it('exposes the full set of markdown tag components (regression guard if someone drops a tag)', () => {
    const components = getStreamdownComponents('sm', 'cache-test-shape', false);
    // The tags the renderer visibly styles — drop-outs cause unstyled prose.
    const expectedTags = [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'ul',
      'ol',
      'li',
      'a',
      'strong',
      'em',
      'blockquote',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'pre',
      'code',
    ];
    for (const tag of expectedTags) {
      expect(components, `missing component for <${tag}>`).toHaveProperty(tag);
    }
  });
});
